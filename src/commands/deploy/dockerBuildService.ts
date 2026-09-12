import { NodeSSH } from 'node-ssh';
import log from '../../utils/logger';
import { exec, AutoFlowError, EXIT_CODES } from './errors';
import { escapeShellArg } from '../../utils/shell';

export async function buildDockerImage(
    ssh: NodeSSH,
    projectDir: string,
    imageName: string
): Promise<void> {
    log.info(`Building Docker image: ${imageName} ...`);
    log.info('This may take a few minutes on first build.');

    try {
        // Pre-build Disk Check: Check available disk space on root filesystem & auto-optimize
        try {
            const getAvailMB = async (): Promise<number> => {
                const dfRes = await ssh.execCommand("df -m / | tail -n 1 | awk '{print $4}'");
                return parseInt(dfRes.stdout.trim(), 10) || 0;
            };

            let availMB = await getAvailMB();
            const MIN_REQUIRED_MB = 1024; // 1 GB minimum safe threshold to attempt a docker build

            if (availMB < 2048) {
                log.warning(`⚠️ Low server disk space detected (${availMB}MB available).`);
                log.info('Running pre-flight cleanup: pruning unused build cache & dangling images...');
                
                // Deep prune of build cache and untagged images before attempting build
                await ssh.execCommand('docker builder prune -a -f || true');
                await ssh.execCommand('docker image prune -f || true');

                // Re-check available space after cleanup
                availMB = await getAvailMB();
                log.info(`Post-cleanup available disk space: ${availMB}MB`);
            }

            if (availMB < MIN_REQUIRED_MB) {
                throw new AutoFlowError(
                    `INSUFFICIENT DISK SPACE: Only ${availMB}MB available on server even after pruning build cache. Docker build requires at least ${MIN_REQUIRED_MB}MB free space to avoid crashing. Please free up disk space on your VPS before deploying.`,
                    EXIT_CODES.BUILD_FAILED,
                    'dockerBuildService'
                );
            }

            log.success(`✔ Pre-flight disk check passed: ${availMB}MB available. Build is viable.`);
        } catch (err: any) {
            if (err instanceof AutoFlowError) throw err;
            // Non-critical check failure (e.g. command parsing), log and proceed
            log.warning(`Could not determine disk space: ${err?.message || err}`);
        }

        await exec(ssh, `
cd ${escapeShellArg(projectDir)} &&
docker build --progress=plain -t ${escapeShellArg(imageName)} . &&
docker builder prune -f --keep-storage=1GB &&
docker image prune -f
`, 600_000, true); // 10-minute timeout for large builds, with streaming logs

        log.success(`Docker image built: ${imageName} ✔`);
    } catch (err: any) {
        const errorMsg = String(err?.message || err);
        if (errorMsg.includes('no space left on device') || errorMsg.includes('disk full')) {
            throw new AutoFlowError(
                `Server disk is FULL! Docker build failed because the VPS has run out of space. Run 'docker builder prune -a -f' on the server or upgrade disk storage.`,
                EXIT_CODES.BUILD_FAILED,
                'dockerBuildService'
            );
        }
        throw new AutoFlowError(
            `Docker build failed for image "${imageName}". Check logs above.`,
            EXIT_CODES.BUILD_FAILED,
            'dockerBuildService'
        );
    }
}
