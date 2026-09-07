import { ipcMain, dialog, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import speakeasy from 'speakeasy';
import { execSync, spawnSync } from 'child_process';

import {
    globalConfigExists,
    loadGlobalConfig,
    saveGlobalConfig,
    clearGlobalConfig,
    loadSavedProjects,
    addProjectToSaved,
    removeProjectFromSaved,
    loadProjectConfig,
    saveProjectConfig,
    projectConfigExists,
    loadSavedProjectsWithMetadata,
    isPathInWorkspace
} from '../core/config';

function assertPathInWorkspace(targetPath: string) {
    if (!isPathInWorkspace(targetPath)) {
        throw new Error(`Access denied: Resolved path "${targetPath}" escapes workspace boundary`);
    }
}

import { vaultEngine, loadVaultConfig, saveVaultConfig } from '../core/vault';
import { projectScanner } from '../core/scanner';
import { initProjectCore } from '../core/initializer';
import { deployerEngine } from '../core/deployer';
import { monitorEngine } from '../core/monitor';
import { connectionManager } from '../core/connection';
import { installerEngine } from '../core/installer';
import { addLogListener, removeLogListener, LogType } from '../utils/logger';
import { installGlobalCli } from './cliInstaller';
import { supabase, setAuthSession, clearAuthSession, getCurrentUserId } from './supabase';

export function registerIpcHandlers(mainWindow: BrowserWindow) {
    // Window Controls
    ipcMain.on('window:minimize', () => {
        mainWindow.minimize();
    });

    ipcMain.on('window:maximize', () => {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    });

    ipcMain.on('window:close', () => {
        mainWindow.close();
    });

    // Global Config & Onboarding
    ipcMain.handle('config:global-exists', () => {
        return globalConfigExists();
    });

    ipcMain.handle('config:load-global', () => {
        try {
            return loadGlobalConfig();
        } catch {
            return null;
        }
    });

    ipcMain.handle('config:save-global', (_, config) => {
        return saveGlobalConfig(config);
    });

    ipcMain.handle('config:clear-global', () => {
        return clearGlobalConfig();
    });

    ipcMain.handle('config:reset-all', () => {
        clearGlobalConfig();
        vaultEngine.deleteVault();
        const projectsPath = path.join(os.homedir(), '.autoflow', 'projects.json');
        if (fs.existsSync(projectsPath)) {
            try {
                fs.unlinkSync(projectsPath);
            } catch {}
        }
        return { success: true };
    });

    ipcMain.handle('vault:generate-totp-secret', () => {
        const secret = speakeasy.generateSecret({ name: 'Autoflow vNext' });
        return {
            secret: secret.base32,
            otpauthUrl: secret.otpauth_url || ''
        };
    });

    // Vault Security
    ipcMain.handle('vault:exists', async () => {
        const vaultPath = path.join(os.homedir(), '.autoflow', 'vault.json');
        try {
            await fs.promises.access(vaultPath, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    });

    ipcMain.handle('vault:setup', (_, password, totpSecret) => {
        return vaultEngine.setupVault(password, totpSecret);
    });

    ipcMain.handle('vault:lock', () => {
        vaultEngine.lock();
        // Disconnect SSH when session locks — will reconnect on next unlock
        connectionManager.disconnect();
        return true;
    });

    ipcMain.handle('vault:unlock', async (_, password, otpToken) => {
        const success = vaultEngine.unlock(password, otpToken);
        if (success) {
            // Re-establish the persistent SSH session after successful unlock
            try {
                const config = loadGlobalConfig();
                await connectionManager.connect(config);
            } catch (err: any) {
                console.error('[IPC] SSH reconnect after unlock failed:', err.message);
                // Don't throw — vault is unlocked, SSH will retry via auto-reconnect
            }
        }
        return success;
    });

    ipcMain.handle('vault:is-unlocked', () => {
        return vaultEngine.isUnlocked();
    });

    ipcMain.handle('vault:save-git-pat', (_, projectName, pat) => {
        if (!vaultEngine.isUnlocked()) return { success: false, error: 'Vault is locked' };
        try {
            const vault = loadVaultConfig();
            if (!vault) return { success: false, error: 'Vault not initialized' };
            if (!vault.projectTokens) vault.projectTokens = {};
            vault.projectTokens[projectName] = vaultEngine.encrypt(pat);
            saveVaultConfig(vault);
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // Secure Vault Writes
    ipcMain.handle('vault:save-ssh-password', (_, password) => {
        if (!vaultEngine.isUnlocked()) return { success: false, error: 'Vault is locked' };
        try {
            const vault = loadVaultConfig();
            if (!vault) return { success: false, error: 'Vault not initialized' };
            vault.sshPassword = vaultEngine.encrypt(password);
            saveVaultConfig(vault);
            return { success: true };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    });

    // Auth sync
    ipcMain.handle('auth:sync-session', async (_, session) => {
        await setAuthSession(session);
        const userId = getCurrentUserId();
        if (userId) {
            const projects = loadSavedProjects();
            let deploymentCount = 0;
            for (const p of projects) {
                let pName = path.basename(p);
                try {
                    const cfg = loadProjectConfig(p);
                    if (cfg.projectName) pName = cfg.projectName;
                } catch { }
                deploymentCount += (deployerEngine.getHistory(pName) || []).length;
            }
            await supabase.from('user_profiles').update({ 
                deployment_count: deploymentCount
            }).eq('id', userId);
        }
    });

    ipcMain.handle('auth:clear-session', async () => {
        await clearAuthSession();
        vaultEngine.lock();
    });

    ipcMain.handle('auth:get-profile', async () => {
        const userId = getCurrentUserId();
        if (!userId) return null;
        const { data } = await supabase.from('user_profiles').select('*').eq('id', userId).single();
        return data;
    });

    ipcMain.handle('window:open-external', (_, url) => {
        require('electron').shell.openExternal(url);
    });

    // File Dialog Browser
    ipcMain.handle('dialog:browse', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory']
        });
        return result.filePaths[0];
    });

    ipcMain.handle('dialog:browse-file', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            filters: [
                { name: 'All Files', extensions: ['*'] },
                { name: 'Keys', extensions: ['pem', 'key', 'pub', 'rsa'] }
            ]
        });
        return result.filePaths[0];
    });

    // Project Scanner — no workspace restriction; user can scan any folder they choose
    ipcMain.handle('scanner:start', async (event, rootDir) => {
        // Basic sanity: must be an absolute path
        if (!path.isAbsolute(rootDir)) {
            mainWindow.webContents.send('scanner:finished', []);
            return;
        }
        try {
            const projects = await projectScanner.scan(
                rootDir,
                (project) => {
                    mainWindow.webContents.send('scanner:project-found', project);
                },
                (count, dir) => {
                    mainWindow.webContents.send('scanner:progress', { count, dir });
                }
            );
            mainWindow.webContents.send('scanner:finished', projects);
        } catch (err: any) {
            mainWindow.webContents.send('scanner:finished', []);
        }
    });

    ipcMain.handle('scanner:abort', () => {
        projectScanner.abort();
    });

    ipcMain.handle('scanner:start-global', async () => {
        try {
            await projectScanner.scanGlobal((project) => {
                mainWindow.webContents.send('scanner:global-project-found', project);
            });
            mainWindow.webContents.send('scanner:global-finished');
        } catch (err) {
            mainWindow.webContents.send('scanner:global-finished');
        }
    });

    // Project Config and Saved list
    ipcMain.handle('projects:get-saved', async () => {
        let serverIp = 'unknown';
        try {
            const globalConfig = loadGlobalConfig();
            serverIp = globalConfig.serverIp || 'unknown';
        } catch {}

        const allProjects = loadSavedProjectsWithMetadata();
        const activeProjects = allProjects.filter((p: any) => p.serverIp === serverIp);
        const projectsMetadata = [];

        for (const p of activeProjects) {
            const localExists = fs.existsSync(p.path);
            try {
                let hasConfig = false;
                let projectName = path.basename(p.path);
                let appType = 'node';
                let gitRepo = '';

                if (localExists) {
                    hasConfig = projectConfigExists(p.path);
                    if (hasConfig) {
                        const config = loadProjectConfig(p.path);
                        projectName = config.projectName || projectName;
                        appType = config.appType || appType;
                        gitRepo = config.gitRepo || '';
                    } else {
                        const pkgPath = path.join(p.path, 'package.json');
                        if (fs.existsSync(pkgPath)) {
                            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                            projectName = pkg.name || projectName;
                        }
                    }
                }

                projectsMetadata.push({
                    projectName,
                    projectPath: p.path,
                    hasConfig,
                    appType,
                    gitRepo,
                    localExists,
                    migrated: p.migrated
                });
            } catch {
                projectsMetadata.push({
                    projectName: path.basename(p.path),
                    projectPath: p.path,
                    hasConfig: false,
                    appType: 'node',
                    gitRepo: '',
                    localExists,
                    migrated: p.migrated
                });
            }
        }
        return projectsMetadata;
    });

    ipcMain.handle('projects:add', async (_, projectPath) => {
        addProjectToSaved(projectPath);
    });

    ipcMain.handle('projects:remove', async (_, projectPath) => {
        removeProjectFromSaved(projectPath);
    });

    ipcMain.handle('projects:load-config', (_, projectPath) => {
        return loadProjectConfig(projectPath);
    });

    ipcMain.handle('projects:save-config', (_, projectPath, config) => {
        return saveProjectConfig(config, projectPath);
    });

    ipcMain.handle('projects:config-exists', (_, projectPath) => {
        return projectConfigExists(projectPath);
    });

    ipcMain.handle('projects:init', async (_, projectPath, options) => {
        mainWindow.webContents.send('init:started', { projectName: options.projectName, startTime: Date.now() });

        const logListener = (type: LogType, message: string) => {
            mainWindow.webContents.send('init:log', {
                projectName: options.projectName,
                timestamp: Date.now(),
                type,
                message,
                step: 'Initialize'
            });
        };

        addLogListener(logListener);

        try {
            await initProjectCore(projectPath, options);
            
            // Save PAT if provided and vault is unlocked
            if (options.gitPat && vaultEngine.isUnlocked()) {
                const vault = loadVaultConfig();
                if (vault) {
                    if (!vault.projectTokens) vault.projectTokens = {};
                    vault.projectTokens[options.projectName] = vaultEngine.encrypt(options.gitPat);
                    saveVaultConfig(vault);
                }
            }

            mainWindow.webContents.send('init:success', { projectName: options.projectName });
            return { success: true };
        } catch (error: any) {
            mainWindow.webContents.send('init:failed', { projectName: options.projectName, error: error.message });
            return { success: false, error: error.message };
        } finally {
            removeLogListener(logListener);
        }
    });

    // Deploy actions — run deployProjectCore directly in the main process and stream logs
    ipcMain.handle('deploy:run', async (_, projectPath) => {
        const deployProjectCore = require('../commands/deploy/index').default;
        const { loadProjectConfig } = require('../core/config');
        const startTime = Date.now();

        let projectName = path.basename(projectPath);
        try {
            const cfg = loadProjectConfig(projectPath);
            projectName = cfg.projectName || projectName;
        } catch { /* use basename fallback */ }

        const userId = getCurrentUserId();

        // Stream every log line straight to the renderer terminal
        const logListener = (type: LogType, message: string) => {
            if (!mainWindow.isDestroyed()) {
                mainWindow.webContents.send('deploy:log', { type, message });
            }
        };
        addLogListener(logListener);

        try {
            await deployProjectCore(true, projectPath); // isDesktop = true, projectDir = projectPath
            removeLogListener(logListener);

            // Save history
            deployerEngine.saveHistoryItem(projectName, {
                id: `dep-${Date.now()}`,
                sequence: deployerEngine.getHistory(projectName).length + 1,
                timestamp: Date.now(),
                duration: Math.round((Date.now() - startTime) / 1000),
                status: 'Live',
                notes: 'Successful deployment',
                commitSha: (() => {
                    try { return require('child_process').execSync('git rev-parse --short HEAD', { cwd: projectPath, encoding: 'utf8' }).trim(); } catch { return 'N/A'; }
                })()
            });



            if (!mainWindow.isDestroyed()) mainWindow.webContents.send('deploy:success', {});
        } catch (err: any) {
            removeLogListener(logListener);

            deployerEngine.saveHistoryItem(projectName, {
                id: `dep-${Date.now()}`,
                sequence: deployerEngine.getHistory(projectName).length + 1,
                timestamp: Date.now(),
                duration: Math.round((Date.now() - startTime) / 1000),
                status: 'Failed',
                notes: err.message,
                commitSha: 'N/A'
            });

            if (!mainWindow.isDestroyed()) mainWindow.webContents.send('deploy:failed', { error: err.message });
        }

        return { success: true };
    });

    ipcMain.handle('deploy:get-history', (_, projectName) => {
        return deployerEngine.getHistory(projectName);
    });

    ipcMain.handle('deploy:rollback', async (_, projectPath, commitSha) => {
        let originalBranch = 'main';
        try {
            originalBranch = execSync('git symbolic-ref --short HEAD', { cwd: projectPath }).toString().trim();
        } catch {
            try {
                originalBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: projectPath }).toString().trim();
            } catch {}
        }

        // Run git checkout & deployment in background so UI doesn't hang,
        // but ensure checkout back to originalBranch happens strictly AFTER deploy finishes
        (async () => {
            try {
                spawnSync('git', ['checkout', commitSha], { cwd: projectPath, stdio: 'ignore' });
                await deployerEngine.deploy(projectPath);
            } catch (err: any) {
                console.error('[Rollback] Failed to deploy rollback commit:', err);
            } finally {
                try {
                    spawnSync('git', ['checkout', originalBranch], { cwd: projectPath, stdio: 'ignore' });
                } catch {}
            }
        })();

        return { success: true };
    });

    ipcMain.handle('deploy:check-interrupted', () => {
        return deployerEngine.checkInterruptedJob();
    });

    ipcMain.handle('deploy:clear-interrupted', () => {
        return deployerEngine.clearActiveJob();
    });

    ipcMain.handle('projects:load-env', async (_, projectPath) => {
        const envPath = path.join(projectPath, '.env');
        if (!fs.existsSync(envPath)) return {};
        try {
            const content = fs.readFileSync(envPath, 'utf-8');
            const env: Record<string, string> = {};
            content.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
                    const idx = trimmed.indexOf('=');
                    const key = trimmed.slice(0, idx).trim();
                    const val = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, '');
                    env[key] = val;
                }
            });
            return env;
        } catch {
            return {};
        }
    });

    ipcMain.handle('projects:save-env', async (_, projectPath, env) => {
        const envPath = path.join(projectPath, '.env');
        try {
            const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
            await fs.promises.writeFile(envPath, lines.join('\n'), 'utf-8');
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // Server Stats Monitor
    ipcMain.handle('server:fetch-stats', async () => {
        try {
            return await monitorEngine.fetchStats();
        } catch (err: any) {
            throw new Error(err.message || 'Failed to fetch server statistics.');
        }
    });

    ipcMain.handle('server:fetch-remote-logs', async (_, name) => {
        try {
            return await monitorEngine.fetchRemoteLogs(name);
        } catch (err: any) {
            return `Failed to fetch remote logs: ${err.message}`;
        }
    });

    // Container Controls
    ipcMain.handle('monitor:stop-container', async (_, name) => {
        return await monitorEngine.stopContainer(name);
    });

    ipcMain.handle('monitor:restart-container', async (_, name) => {
        return await monitorEngine.restartContainer(name);
    });

    ipcMain.handle('monitor:delete-container', async (_, name) => {
        return await monitorEngine.deleteContainer(name);
    });

    // Connection Manager
    ipcMain.handle('connection:get-state', () => {
        return connectionManager.getState();
    });

    ipcMain.handle('connection:connect', async () => {
        try {
            const config = loadGlobalConfig();
            await connectionManager.connect(config);
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    // Intentional disconnect — only used when settings change or factory reset.
    // Do NOT call this for normal app usage; SSH must stay persistent.
    ipcMain.handle('connection:disconnect', async () => {
        await connectionManager.disconnect();
        return { success: true };
    });

    // Dependency Installer
    ipcMain.handle('installer:check-dependencies', async () => {
        const pkgManager = await installerEngine.detectPackageManager();
        const deps = await installerEngine.checkDependencies();
        return { pkgManager, deps };
    });

    ipcMain.handle('installer:install-dependencies', async (_, depsToInstall, pkgManager) => {
        await installerEngine.installMissing(depsToInstall, pkgManager, (logMsg) => {
            if (!mainWindow.isDestroyed()) mainWindow.webContents.send('installer:log', logMsg);
        });
        return { success: true };
    });

    vaultEngine.on('lock-state-change', (locked) => {
        if (!mainWindow.isDestroyed()) mainWindow.webContents.send('vault:locked-state-change', locked);
    });

    connectionManager.on('state-changed', (state) => {
        if (!mainWindow.isDestroyed()) mainWindow.webContents.send('connection:state-changed', state);
    });

    // CLI Integration
    ipcMain.handle('install-cli', () => {
        try {
            return { success: true, message: installGlobalCli() };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });
}
