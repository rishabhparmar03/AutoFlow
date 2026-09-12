import { NodeSSH } from 'node-ssh';
import chalk from 'chalk';
import log from '../../utils/logger';
import { exec, AutoFlowError, EXIT_CODES } from './errors';
import { escapeShellArg } from '../../utils/shell';

export async function startContainer(
    ssh: NodeSSH,
    projectDir: string,
    containerName: string,
    imageName: string,
    hostPort: string,
    containerPort: number,
    useDomain: boolean,
    hasEnv: boolean = false,
    volumes: string[] = []
): Promise<void> {
    // Stop and remove old container if running
    await ssh.execCommand(`docker rm -f ${escapeShellArg(containerName)} || true`);

    const portBinding = useDomain
        ? `-p 127.0.0.1:${hostPort}:${containerPort}`
        : `-p ${hostPort}:${containerPort}`;

    const envLine = hasEnv ? '--env-file .env' : '';

    // Prepare volume bindings
    let volumeBinding = '';
    if (volumes && volumes.length > 0) {
        log.info('Preparing persistent volumes...');
        for (const vol of volumes) {
            // vol format expected: "hostPath:containerPath" or just "containerPath"
            // If just containerPath, we map it to projectDir/data/containerPath
            let [host, container] = vol.includes(':') ? vol.split(':') : [null, vol];
            
            if (!host) {
                // Default to a 'data' directory in project root if not specified
                const safeDir = container.replace(/^\//, '').replace(/\//g, '_');
                host = `${projectDir}/data/${safeDir}`;
            }

            // Ensure host directory exists
            await ssh.execCommand(`mkdir -p ${escapeShellArg(host)}`);
            volumeBinding += `-v ${escapeShellArg(host)}:${escapeShellArg(container)} `;
        }
    }

    log.info(`Port mapping: Host:${hostPort} → Container:${containerPort}`);
    if (hasEnv) {
        log.info('Starting container with Z+ environment injection...');
    } else {
        log.info('Starting container...');
    }

    const runCmd = [
        'docker run -d',
        '--restart unless-stopped',
        portBinding,
        volumeBinding.trim(),
        `--name ${escapeShellArg(containerName)}`,
        envLine,
        escapeShellArg(imageName)
    ].filter(Boolean).join(' ');

    await exec(ssh, `cd ${escapeShellArg(projectDir)} && ${runCmd}`);
}

/**
 * Probes container HTTP response on localhost mapped port.
 * Ponytail: reuses curl probe pattern from status.ts:74-78.
 * Rejects 5xx and 000/empty (unreachable); allows 2xx, 3xx, 401, 403, 404 to avoid false rollbacks.
 */
export async function probeContainerHttp(
    ssh: NodeSSH,
    containerName: string,
    hostPort?: string
): Promise<{ healthy: boolean; code: string }> {
    let mappedPort = hostPort || '';
    if (!mappedPort) {
        const safeContainer = escapeShellArg(containerName);
        const portCmd = await ssh.execCommand(`docker port ${safeContainer}`);
        if (portCmd.stdout) {
            const match = portCmd.stdout.match(/0\.0\.0\.0:(\d+)/) || portCmd.stdout.match(/127\.0\.0\.1:(\d+)/);
            if (match && match[1]) {
                mappedPort = match[1];
            }
        }
    }

    if (!mappedPort) {
        // If container exposes no host port (e.g. pure worker, domain-free, or test mock), fallback to docker status
        return { healthy: true, code: 'N/A' };
    }

    const health = await ssh.execCommand(
        `curl -I -s -o /dev/null -w "%{http_code}" --connect-timeout 3 http://127.0.0.1:${mappedPort} || true`
    );
    const httpCode = (health.stdout || '').trim();

    // 000 = curl failed to connect, 5xx = server error
    if (!httpCode || httpCode === '000' || httpCode.startsWith('5')) {
        return { healthy: false, code: httpCode || '000' };
    }

    return { healthy: true, code: httpCode };
}

export async function verifyContainerHealth(
    ssh: NodeSSH,
    containerName: string,
    hostPort?: string
): Promise<void> {
    log.info('Verifying container health and readiness...');

    let isHealthy = false;
    let attempts = 0;
    // Production tolerance: Fullstack apps (Laravel/Node/Python) running migrations or
    // booting sub-services require up to 30-45 seconds to bind to port.
    const maxAttempts = 15;
    const intervalMs = 3000;
    let lastProbeResult = { healthy: false, code: '' };
    const safeContainer = escapeShellArg(containerName);

    while (attempts < maxAttempts) {
        attempts++;

        // 1. Inspect container process state via inspect or ps
        const inspectRes = await ssh.execCommand(
            `docker inspect -f '{{.State.Status}} {{.State.ExitCode}} {{.State.Health.Status}}' ${safeContainer} 2>/dev/null || docker ps -a --filter ${escapeShellArg(`name=^/${containerName}$`)} --format "{{.Status}}"`
        );
        const rawOutput = (inspectRes.stdout || '').trim();
        let stateStatus = 'not_found';
        let exitCode = 0;
        let isHealthyState = false;

        if (rawOutput.includes('Up') || rawOutput.startsWith('running')) {
            stateStatus = 'running';
        } else if (rawOutput.includes('Exited') || rawOutput.startsWith('exited') || rawOutput.startsWith('dead')) {
            stateStatus = 'exited';
            const exitMatch = rawOutput.match(/\((\d+)\)/);
            if (exitMatch) exitCode = parseInt(exitMatch[1], 10);
        }

        // Fast-fail: if container died or exited, abort immediately instead of hanging
        if (stateStatus === 'exited' || stateStatus === 'dead') {
            const logs = await ssh.execCommand(`docker logs --tail 40 ${safeContainer}`);
            log.error('\n=== CONTAINER CRASH LOGS (Process terminated) ===');
            log.error(logs.stdout || logs.stderr || '(No logs emitted)');
            log.error('================================================\n');

            throw new AutoFlowError(
                `Container "${containerName}" failed to start or exited immediately (exit code: ${exitCode}).`,
                EXIT_CODES.CONTAINER_FAILED,
                'containerService'
            );
        }

        // Fast-fail if Docker's internal HEALTHCHECK explicitly flagged it as unhealthy
        if (rawOutput.includes('unhealthy')) {
            const logs = await ssh.execCommand(`docker logs --tail 40 ${safeContainer}`);
            log.error('\n=== CONTAINER LOGS (Docker Healthcheck Failed) ===');
            log.error(logs.stdout || logs.stderr || '(No logs emitted)');
            log.error('================================================\n');

            throw new AutoFlowError(
                `Container "${containerName}" was marked unhealthy by Docker healthcheck.`,
                EXIT_CODES.CONTAINER_FAILED,
                'containerService'
            );
        }

        // 2. If running, probe HTTP readiness
        if (stateStatus === 'running') {
            if (hostPort) {
                const probe = await probeContainerHttp(ssh, containerName, hostPort);
                lastProbeResult = probe;
                if (probe.healthy) {
                    isHealthy = true;
                    break;
                }
            } else {
                isHealthy = true;
                break;
            }
        }

        if (attempts < maxAttempts) {
            const elapsed = attempts * (intervalMs / 1000);
            log.info(`  ... Service initializing (${lastProbeResult.code ? `HTTP ${lastProbeResult.code}` : 'binding port'}, ${elapsed}s elapsed, attempt ${attempts}/${maxAttempts})...`);
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
    }

    if (!isHealthy) {
        const logs = await ssh.execCommand(`docker logs --tail 40 ${safeContainer}`);
        log.error('\n=== CONTAINER LOGS (Readiness Timeout) ===');
        log.error(logs.stdout || logs.stderr || '(No logs emitted)');
        log.error('==========================================\n');

        throw new AutoFlowError(
            `Container "${containerName}" did not become ready within 45s (last HTTP status: ${lastProbeResult.code || 'Connection refused'}). Check if the web service inside the container is listening on the expected port.`,
            EXIT_CODES.CONTAINER_FAILED,
            'containerService'
        );
    }

    log.success(`Container "${containerName}" is healthy and serving traffic (HTTP ${lastProbeResult.code}) ✔`);
}
