import { NodeSSH } from 'node-ssh';
import path from 'path';
import log from '../../utils/logger';
import { exec, AutoFlowError, EXIT_CODES } from './errors';
import { escapeShellArg } from '../../utils/shell';

export async function configureNginx(
    ssh: NodeSSH,
    domain: string,
    projectName: string,
    sshUser: string,
    hostPort: string
): Promise<void> {
    log.info(`Configuring Nginx for domain: ${domain}`);

    await setupGlobalDefaultServer(ssh);

    const nginxConf = `# AutoFlow-managed configuration (${projectName})
server {
    listen 80;
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${hostPort};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;
    }
}
`;

    const safeProjectName = path.posix.basename(projectName);
    const confPath = `/etc/nginx/sites-available/${safeProjectName}`;

    // ── Conflict resolution ──────────────────────────────────────────────────
    log.info('Scanning for conflicting Nginx configs...');
    const safeDomain = escapeShellArg(domain);
    const conflictCheck = await ssh.execCommand(
        `grep -Rl ${safeDomain} /etc/nginx/sites-enabled/ 2>/dev/null || true`
    );

    if (conflictCheck.stdout.trim()) {
        const conflicts = conflictCheck.stdout.trim().split('\n');

        for (const conflict of conflicts) {
            const conflictName = path.basename(conflict);

            // Skip our own project or certbot-generated variants of it
            if (
                conflictName === safeProjectName ||
                conflictName.startsWith(`${safeProjectName}-`)
            ) continue;

            // Read file and verify it's actually serving this exact domain
            const contentCmd = await ssh.execCommand(`cat "${conflict}"`);
            const clean = (contentCmd.stdout || '').replace(/#.*/g, '');
            const serverNameMatches = clean.match(/server_name\s+([^;]+);/g);

            let isConflict = false;
            if (serverNameMatches) {
                for (const m of serverNameMatches) {
                    const args = m.replace('server_name', '').replace(';', '').trim().split(/\s+/);
                    if (args.includes(domain)) { isConflict = true; break; }
                }
            }

            if (isConflict) {
                log.warning(`Found conflicting config: ${conflictName}. Backing up and removing...`);
                // Ponytail / F13: escape shell arguments
                await exec(ssh, `sudo cp ${escapeShellArg(conflict)} /home/${escapeShellArg(sshUser)}/backup-${escapeShellArg(conflictName)}.conf || true`);
                await exec(ssh, `sudo rm -f ${escapeShellArg(conflict)}`);
                await exec(ssh, `sudo rm -f /etc/nginx/sites-available/${escapeShellArg(conflictName)}`);
                log.success(`Removed conflict: ${conflictName} (backup kept)`);
            } else {
                log.info(`Ignoring false positive: ${conflictName}`);
            }
        }
    }

    const enabledPath = `/etc/nginx/sites-enabled/${safeProjectName}`;
    const backupPath = `/etc/nginx/sites-available/${safeProjectName}.bak`;

    // Ponytail / F5: Backup existing config if one already exists before writing candidate
    await ssh.execCommand(`sudo test -f ${confPath} && sudo cp ${confPath} ${backupPath} || true`);

    await exec(ssh, `cat <<'NGINX_EOF' | sudo tee ${confPath} > /dev/null
${nginxConf}
NGINX_EOF`);
    await exec(ssh, `sudo ln -sf ${confPath} ${enabledPath}`);

    // Update port in case SSL config already exists
    await exec(
        ssh,
        `sudo sed -i 's|proxy_pass http://127.0.0.1:[0-9]*;|proxy_pass http://127.0.0.1:${hostPort};|g' /etc/nginx/sites-enabled/${safeProjectName}* 2>/dev/null || true`
    );

    // Test config
    const test = await ssh.execCommand('sudo nginx -t 2>&1');
    if (test.code !== 0) {
        // Ponytail / F5: Clean up candidate symlink to avoid breaking whole server for all projects!
        await ssh.execCommand(`sudo rm -f ${enabledPath}`);
        // Restore previous backup if existed
        const hasBackup = await ssh.execCommand(`sudo test -f ${backupPath} && echo "YES" || echo "NO"`);
        if (hasBackup.stdout.trim() === 'YES') {
            await ssh.execCommand(`sudo cp ${backupPath} ${confPath} && sudo ln -sf ${confPath} ${enabledPath} || true`);
            await ssh.execCommand(`sudo rm -f ${backupPath}`);
        } else {
            await ssh.execCommand(`sudo rm -f ${confPath}`);
        }

        throw new AutoFlowError(
            `Nginx config test failed (candidate config removed to preserve server stability):\n${test.stdout}\n${test.stderr}`,
            EXIT_CODES.NGINX_FAILED,
            'nginxService'
        );
    }

    // Candidate passed, remove temp backup
    await ssh.execCommand(`sudo rm -f ${backupPath} || true`);

    await exec(ssh, 'sudo systemctl reload nginx');

    // SELinux fix (for RHEL/CentOS servers)
    await ssh.execCommand('sudo setsebool -P httpd_can_network_connect 1 2>/dev/null || true');

    log.success('Nginx configured and reloaded ✔');
}

async function setupGlobalDefaultServer(ssh: NodeSSH): Promise<void> {
    const catchAllPath = '/etc/nginx/sites-available/000-autoflow-catchall';
    const checkExists = await ssh.execCommand(`test -f ${catchAllPath} && echo "EXISTS" || echo "MISSING"`);
    if (checkExists.stdout.trim() === 'EXISTS') {
        return; // Already configured
    }

    log.info('Setting up global Nginx catch-all for unmatched domains...');

    // Try modern approach first (Nginx 1.19.4+)
    const modernConf = `server {
    listen 80 default_server;
    server_name _;
    return 444;
}

server {
    listen 443 ssl default_server;
    server_name _;
    ssl_reject_handshake on;
}
`;

    // Fallback approach (Older Nginx)
    const fallbackConf = `server {
    listen 80 default_server;
    server_name _;
    return 444;
}

server {
    listen 443 ssl default_server;
    server_name _;
    ssl_certificate /etc/ssl/certs/ssl-cert-snakeoil.pem;
    ssl_certificate_key /etc/ssl/private/ssl-cert-snakeoil.key;
    return 444;
}
`;

    // Inspect default nginx config before removing it
    const defaultCheck = await ssh.execCommand('cat /etc/nginx/sites-enabled/default 2>/dev/null || true');
    const defaultContent = defaultCheck.stdout || '';
    
    // Only unlink default if it's unmanaged and contains no custom tools like phpMyAdmin
    if (defaultContent && !defaultContent.includes('phpmyadmin') && !defaultContent.includes('location /phpmyadmin')) {
        // Ponytail / F12: Backup default config before removing
        await ssh.execCommand('sudo cp /etc/nginx/sites-enabled/default /etc/nginx/sites-available/default.bak 2>/dev/null || true');
        await ssh.execCommand('sudo rm -f /etc/nginx/sites-enabled/default');
    }

    // Attempt modern config
    await ssh.execCommand(`cat <<'NGINX_EOF' | sudo tee ${catchAllPath} > /dev/null\n${modernConf}\nNGINX_EOF`);
    await ssh.execCommand(`sudo ln -sf ${catchAllPath} /etc/nginx/sites-enabled/000-autoflow-catchall`);

    const testModern = await ssh.execCommand('sudo nginx -t 2>&1');
    
    if (testModern.code !== 0) {
        log.info('Older Nginx version detected. Using legacy catch-all configuration...');
        
        // Ensure ssl-cert package exists for snakeoil certs
        const checkSslCert = await ssh.execCommand('dpkg -l | grep -q ssl-cert || echo "MISSING"');
        if (checkSslCert.stdout.trim() === 'MISSING') {
            await ssh.execCommand('sudo apt-get update && sudo apt-get install -y ssl-cert', { execOptions: { pty: false } } as object);
        }
        await ssh.execCommand('sudo make-ssl-cert generate-default-snakeoil --force-overwrite || true');

        // Apply fallback config
        await ssh.execCommand(`cat <<'NGINX_EOF' | sudo tee ${catchAllPath} > /dev/null\n${fallbackConf}\nNGINX_EOF`);
        const testFallback = await ssh.execCommand('sudo nginx -t 2>&1');
        
        if (testFallback.code !== 0) {
            log.warning('Failed to configure global Nginx catch-all. Reverting to avoid downtime.');
            await ssh.execCommand(`sudo rm -f /etc/nginx/sites-enabled/000-autoflow-catchall`);
        }
    }
    
    await ssh.execCommand('sudo systemctl reload nginx || true');
}
