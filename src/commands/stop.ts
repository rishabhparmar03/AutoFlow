import { NodeSSH } from 'node-ssh';
import chalk from 'chalk';
import log from '../utils/logger';
import { loadGlobalConfig, loadProjectConfig } from '../core/config';
import { escapeShellArg } from '../utils/shell';

async function execSafe(ssh: NodeSSH, command: string): Promise<void> {
    const result = await ssh.execCommand(command);
    if (result.code !== 0) {
        log.warning(`Command returned non-zero: ${command.slice(0, 80)}`);
        if (result.stderr) console.log(chalk.yellow(result.stderr));
        // Non-throwing: we want to complete all cleanup steps even if one fails
    }
}

async function stop(isDesktop: boolean = false, projectDir: string = process.cwd()): Promise<void> {
    const projectConfig = loadProjectConfig(projectDir);
    const globalConfig = loadGlobalConfig();
    const config = { ...globalConfig, ...projectConfig };

    log.header(`STOPPING SERVICE: ${config.projectName.toUpperCase()}`);
    log.info(`Connecting to ${config.serverIp}...`);

    const ssh = new NodeSSH();

    try {
        await ssh.connect({
            host: config.serverIp,
            username: config.sshUser,
            port: Number(config.sshPort),
            privateKeyPath: config.sshKeyPath.replace(/^"|"$/g, ''),
        });

        const container = config.projectName;
        const remoteProjectDir = `/home/${config.sshUser}/apps/${config.projectName}`;

        const safeContainer = escapeShellArg(container);
        const safeProjectName = escapeShellArg(config.projectName);
        const safeRemoteProjectDir = escapeShellArg(remoteProjectDir);

        // 1. Stop container (keep container and rollback snapshot for recovery)
        log.info('Stopping container...');
        await execSafe(ssh, `docker stop ${safeContainer}`);

        // Note: We intentionally do NOT rm -f ${safeContainer}_rollback so that rollback snapshot is preserved.
        try {
            const { deployerEngine } = require('../core/deployer');
            deployerEngine.logContainerAction(config.projectName, 'Stopped');
        } catch {}

        // 2. Prune dangling builder images for this project
        log.info('Pruning unused Docker builder images...');
        await execSafe(ssh, 'docker image prune -f');

        // 3. Nginx configuration is intentionally preserved.
        // This maintains domain ownership and prevents the routing from falling back
        // to a default server block while the container is offline.
        log.info('Nginx routing preserved (domain ownership maintained).');

        log.success('Service stopped successfully ✅');
        log.info('To redeploy, run: autoflow deploy');

    } catch (err) {
        log.error('Failed to stop service.');
        console.error(err);
    } finally {
        ssh.dispose();
    }
}

export default stop;
