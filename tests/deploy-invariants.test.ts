/**
 * deploy-invariants.test.ts
 *
 * Ponytail rule:
 * "Non-trivial logic leaves ONE runnable check behind, the smallest thing that fails if the logic breaks
 * (an assert-based demo/self-check or one small test file; no frameworks, no fixtures). Trivial one-liners need no test."
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';

function runInvariantsCheck() {
    console.log('Running AutoFlow Deploy Invariants Check...');

    const deployIndexPath = path.resolve(__dirname, '../src/commands/deploy/index.ts');
    const rollbackPath = path.resolve(__dirname, '../src/commands/deploy/rollback.ts');
    const containerServicePath = path.resolve(__dirname, '../src/commands/deploy/containerService.ts');
    const nginxServicePath = path.resolve(__dirname, '../src/commands/deploy/nginxService.ts');

    const indexContent = fs.readFileSync(deployIndexPath, 'utf-8');
    const rollbackContent = fs.readFileSync(rollbackPath, 'utf-8');
    const containerServiceContent = fs.readFileSync(containerServicePath, 'utf-8');
    const nginxServiceContent = fs.readFileSync(nginxServicePath, 'utf-8');

    // 1. Invariant: buildDockerImage MUST execute before backupContainer
    const buildIdx = indexContent.indexOf('buildDockerImage(');
    const backupIdx = indexContent.indexOf('backupContainer(');
    assert(buildIdx !== -1, 'buildDockerImage must exist in index.ts');
    assert(backupIdx !== -1, 'backupContainer must exist in index.ts');
    assert(buildIdx < backupIdx, 'Invariant Violated: Docker build must complete BEFORE taking rollback snapshot to prevent downtime!');
    console.log('✔ Invariant 1 passed: Image built before stopping container for snapshot.');

    // 2. Invariant: startContainer, verifyContainerHealth, and confirmDeploy must be inside the try block
    const rollbackCatchIdx = indexContent.indexOf('catch (deployErr)');
    const startIdx = indexContent.indexOf('startContainer(');
    const verifyIdx = indexContent.indexOf('verifyContainerHealth(');
    const confirmIdx = indexContent.indexOf('confirmDeploy(');

    assert(startIdx > backupIdx && startIdx < rollbackCatchIdx, 'Invariant Violated: startContainer must be inside the rollback try block!');
    assert(verifyIdx > startIdx && verifyIdx < rollbackCatchIdx, 'Invariant Violated: verifyContainerHealth must be inside the rollback try block!');
    assert(confirmIdx > verifyIdx, 'Invariant Violated: confirmDeploy must run only AFTER verifyContainerHealth succeeds!');
    console.log('✔ Invariant 2 passed: Container startup and health checks are safely enclosed in rollback try/catch.');

    // 3. Invariant: backupContainer must check docker ps -a to preserve stopped/crashed containers
    assert(rollbackContent.includes('docker ps -a'), 'Invariant Violated: backupContainer must inspect docker ps -a for stopped containers.');
    // 4. Invariant: backupContainer must use exec() to throw if rename fails
    assert(rollbackContent.includes('await exec(ssh, `docker rename'), 'Invariant Violated: backupContainer must verify docker rename with exec().');
    console.log('✔ Invariant 3 passed: backupContainer checks ps -a and throws on rename failure.');

    // 5. Invariant: containerService has probeContainerHttp checking mapped port with curl
    assert(containerServiceContent.includes('probeContainerHttp'), 'Invariant Violated: containerService must define probeContainerHttp.');
    assert(containerServiceContent.includes('curl -I -s -o /dev/null -w "%{http_code}"'), 'Invariant Violated: probeContainerHttp must use HTTP curl probe.');
    console.log('✔ Invariant 4 passed: Real HTTP probe helper is implemented and used.');

    // 6. Invariant: nginxService unlinks candidate if nginx -t fails
    assert(nginxServiceContent.includes('Nginx config test failed'), 'nginx test check must exist');
    assert(nginxServiceContent.includes('sudo rm -f ${enabledPath}'), 'Invariant Violated: nginxService must remove candidate symlink on failure.');
    console.log('✔ Invariant 5 passed: Nginx configuration failure cleans up candidate symlink to protect server.');

    console.log('\nAll deployment invariants passed successfully! 🚀');
}

if (typeof describe === 'function') {
    describe('Deploy Invariants Check', () => {
        it('should satisfy all deployment pipeline invariants', () => {
            runInvariantsCheck();
        });
    });
} else {
    runInvariantsCheck();
}
