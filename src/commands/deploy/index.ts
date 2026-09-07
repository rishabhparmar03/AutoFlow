import log from '../../utils/logger';
import { handleFatalError } from './errors';
import { loadConfig } from './configService';
import { runCIChecks, waitForRemoteCI } from './ci';
import { syncLocalGit } from './gitService';
import { connectSSH } from './sshService';
import { ensureSwap } from './swapService';
import { allocatePort } from './portService';
import { pullCodeOnServer } from './remoteGitService';
import { buildDockerImage } from './dockerBuildService';
import { startContainer, verifyContainerHealth } from './containerService';
import { backupContainer, confirmDeploy, triggerRollback } from './rollback';
import { configureNginx } from './nginxService';
import { provisionSSL } from './sslService';
import { configureUFW } from './ufwService';
import { syncEnv, unlockEnvOnServer, cleanupEnv } from './envService';
import { loadVaultConfig } from '../../core/vault';
import { vaultEngine } from '../../core/vault';
import { AutoFlowError, EXIT_CODES, unregisterCleanupHandlers } from './errors';
import { promptConsole } from '../../utils/console';
import fs from 'fs';
import path from 'path';

import os from 'os';

const LOCK_FILE = path.join(os.homedir(), '.autoflow', 'jobs', 'deploy.lock');

async function deploy(isDesktop: boolean = false, projectDir: string = process.cwd()): Promise<void> {
    let lockFd: number | null = null;
    let acquired = false;
    let attempts = 0;
    while (!acquired && attempts < 2) {
        attempts++;
        try {
            fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
            lockFd = fs.openSync(LOCK_FILE, 'wx');
            fs.writeFileSync(lockFd, process.pid.toString(), 'utf-8');
            acquired = true;
        } catch (err) {
            if (fs.existsSync(LOCK_FILE)) {
                try {
                    const content = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
                    const pid = parseInt(content, 10);
                    let processRunning = false;
                    if (!isNaN(pid)) {
                        try {
                            process.kill(pid, 0);
                            processRunning = true;
                        } catch (killErr: any) {
                            processRunning = killErr.code !== 'ESRCH';
                        }
                    }
                    if (!processRunning) {
                        try { fs.unlinkSync(LOCK_FILE); } catch {}
                        continue;
                    }
                } catch (readErr) {
                    try { fs.unlinkSync(LOCK_FILE); } catch {}
                    continue;
                }
            }
            throw new AutoFlowError('Another deployment is already in progress.', EXIT_CODES.CI_FAILED, 'deploy');
        } finally {
            if (lockFd !== null) {
                try { fs.closeSync(lockFd); } catch {}
            }
        }
    }

    // Top-level catch — ensures NO raw stack traces ever reach the user
    let fatalErr: unknown = null;
    const deployStartTime = Date.now();
    let configProjectName = '';
    try {
        // ── Step 1: Load config ──────────────────────────────────────────────
        log.header('AUTOFLOW DEPLOY');
        const dir = typeof projectDir === 'string' ? projectDir : process.cwd();
        const config = loadConfig(dir);
        configProjectName = config.projectName;

        const remoteProjectDir = `/home/${config.sshUser}/apps/${config.projectName}`;
        const image = `${config.projectName}:latest`;
        const container = config.projectName;
        const containerPort = config.appType === 'static' ? 80 : 3000;

        // ── Step 1.5: Vault Authentication (Early Unlock) ────────────────────
        const vault = loadVaultConfig();
        let pat: string | undefined;

        if (vault) {
            const needsUnlock = vault.projectTokens?.[config.projectName] || fs.existsSync(path.join(projectDir, '.env'));
            if (needsUnlock && !vaultEngine.isUnlocked()) {
                if (isDesktop) {
                    throw new AutoFlowError('Vault is locked. Please unlock it in the desktop app first.', EXIT_CODES.CI_FAILED, 'vault');
                }
                log.header('Z+ SECURITY CHALLENGE');
                const password = await promptConsole('? Enter Master Deployment Password: ', true);
                const token = await promptConsole('? Enter 6-digit OTP from your phone: ');

                if (!vaultEngine.unlock(password, token)) {
                    throw new AutoFlowError('Invalid Vault credentials.', EXIT_CODES.CI_FAILED, 'vault');
                }
                log.success('✔ Z+ Identity Verified. Session Unlocked.');
            }

            if (vault.projectTokens?.[config.projectName] && vaultEngine.isUnlocked()) {
                pat = vaultEngine.decrypt(vault.projectTokens[config.projectName]);
            }
        }

        // ── Step 2: Local CI Checks (pre-push) ────────────────────────────────
        await runCIChecks(projectDir, config.appType, config.strictCI);

        // ── Step 3: Git sync (local → remote repo) ───────────────────────────
        const sha = await syncLocalGit(projectDir, config.branch);

        // ── Step 4: Remote CI Checks (GitHub Actions) ───────────────────────
        await waitForRemoteCI(config.gitRepo, sha, config.strictCI);

        // ── Step 5: SSH Connect ──────────────────────────────────────────────
        const ssh = await connectSSH(config, isDesktop);

        try {
            // ── Step 5: Swap memory ──────────────────────────────────────────
            await ensureSwap(ssh);

            // ── Step 6: Port allocation ──────────────────────────────────────
            const hostPort = await allocatePort(ssh, container);

            // ── Step 7: Pull code on server ──────────────────────────────────
            await pullCodeOnServer(ssh, remoteProjectDir, config.gitRepo, config.branch, pat);

            // ── Step 8: Build Docker image (old container remains online!) ────
            await buildDockerImage(ssh, remoteProjectDir, image);

            // ── Step 9: Rollback snapshot — take snapshot just before swap ───
            await backupContainer(ssh, container);

            // Ponytail / F2: Widen try block to protect the entire swap & verify window
            try {
                // ── Step 10: Environment Sync & Container Start ──────────────────
                let envUnlocked = false;

                try {
                    if (vault) {
                        const password = await syncEnv(ssh, remoteProjectDir, projectDir);
                        if (password) {
                            await unlockEnvOnServer(ssh, remoteProjectDir, password, vault.salt);
                            envUnlocked = true;
                        }
                    }

                    // ── Step 10: Start new container ─────────────────────────────────
                    await startContainer(ssh, remoteProjectDir, container, image, hostPort, containerPort, !!config.domain, envUnlocked, config.volumes);
                } finally {
                    // Ponytail / F8: Plaintext .env is cleaned up even if startContainer throws
                    if (envUnlocked) {
                        await cleanupEnv(ssh, remoteProjectDir);
                    }
                }

                // ── Step 11: Real Health Check ───────────────────────────────────
                await verifyContainerHealth(ssh, container, hostPort);

                // ── Step 12 & 13: Nginx + SSL (domain mode only) ─────────────────
                await configureUFW(ssh, hostPort, !!config.domain, config.sshPort);

                if (config.domain) {
                    await configureNginx(ssh, config.domain, config.projectName, config.sshUser, hostPort);
                    await provisionSSL(ssh, config.domain);
                } else {
                    log.success(`Live at: http://${config.serverIp}:${hostPort}`);
                }

                // Ponytail / F6: Confirm deploy and delete _rollback ONLY after network routing succeeds
                await confirmDeploy(ssh, container);

            } catch (deployErr) {
                log.warning('Deployment step failed during swap. Attempting rollback...');
                let rollbackSsh = ssh;
                try {
                    await ssh.execCommand('echo 1');
                } catch {
                    log.info('SSH connection lost. Reconnecting for rollback...');
                    rollbackSsh = await connectSSH(config, isDesktop);
                }
                try {
                    await triggerRollback(rollbackSsh, container);
                } finally {
                    if (rollbackSsh !== ssh) try { rollbackSsh.dispose(); } catch {}
                }
                throw deployErr;
            }

            log.header('DEPLOYMENT COMPLETE 🚀');

            // Save history for CLI runs (ensures Dashboard Timeline & Recent Activity always sync)
            if (!isDesktop) {
                try {
                    const { deployerEngine } = require('../../core/deployer');
                    deployerEngine.saveHistoryItem(config.projectName, {
                        id: `dep-${Date.now()}`,
                        sequence: deployerEngine.getHistory(config.projectName).length + 1,
                        timestamp: Date.now(),
                        duration: Math.round((Date.now() - deployStartTime) / 1000),
                        status: 'Live',
                        notes: 'Deployed via CLI',
                        commitSha: sha ? sha.substring(0, 7) : 'N/A'
                    });
                } catch {}
            }

        } finally {
            try {
                unregisterCleanupHandlers(ssh);
                // Forcibly destroy the underlying socket to prevent node-ssh from hanging indefinitely 
                // if a stream was left open by the server.
                if ((ssh as any).connection) {
                    (ssh as any).connection.destroy();
                }
                ssh.dispose();
            } catch {}
        }

    } catch (err: unknown) {
        fatalErr = err;
        if (!isDesktop) {
            try {
                const { deployerEngine } = require('../../core/deployer');
                deployerEngine.saveHistoryItem(configProjectName || 'Unknown', {
                    id: `dep-${Date.now()}`,
                    sequence: deployerEngine.getHistory(configProjectName || 'Unknown').length + 1,
                    timestamp: Date.now(),
                    duration: Math.round((Date.now() - deployStartTime) / 1000),
                    status: 'Failed',
                    notes: (err as any)?.message || 'Deployment failed',
                    commitSha: 'N/A'
                });
            } catch {}
        }
    } finally {
        // Lock file is ALWAYS cleaned up before process.exit
        if (fs.existsSync(LOCK_FILE)) {
            try { fs.unlinkSync(LOCK_FILE); } catch {}
        }
    }

    if (fatalErr) {
        if (isDesktop) throw fatalErr;
        // Single unified error handler — formats every error cleanly, no stack traces
        handleFatalError(fatalErr);
    }

    if (!isDesktop && process.env.NODE_ENV !== 'test') {
        // Diagnostic logs for Issue 3 terminal hang investigation
        log.info(`[Diagnostic] Reached absolute end of deploy execution. isDesktop=${isDesktop}`);
        log.info('[Diagnostic] Calling process.exit(0) now...');
        process.exit(0); // Ensure process terminates instantly in CLI mode
    }
}

export default deploy;
