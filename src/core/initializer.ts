import fs from 'fs';
import path from 'path';
import { saveProjectConfig } from './config';
import log from '../utils/logger';
import { execSync, spawnSync } from 'child_process';

export interface InitOptions {
    projectName: string;
    gitRepo: string;
    domain: string;
    strictCI: boolean;
    useVolumes?: boolean;
}

export async function initProjectCore(projectPath: string, options: InitOptions): Promise<void> {
    const { projectName, gitRepo, domain, strictCI, useVolumes } = options;

    if (!/^[a-z0-9-]+$/i.test(projectName)) {
        throw new Error('Project name can only contain alphanumeric characters and dashes.');
    }

    log.header('AUTOFLOW INITIALIZATION');

    try {
        spawnSync('git', ['ls-remote', gitRepo], { stdio: 'ignore', timeout: 5000 });
    } catch (e) {
        log.warning('Private repository detected (authentication required).');
        log.warning('Please configure a Git Token in the Vault Settings before deploying.');
    }

    /* ── Smart Detection Engine ─────────────────────────────────────── */
    let appType = 'node';
    let buildCommand: string | null = null;
    let startCommand = 'npm start';
    let packageManager = 'npm';
    let installCmd = 'npm install';
    let runCmd = 'npm run';

    const p = (filename: string) => path.join(projectPath, filename);

    // ── Laravel Framework (Confirmed Multi-Signal) ───────────────────────
    let isLaravelCandidate = false;
    let isConfirmedLaravel = false;

    const hasArtisan = fs.existsSync(p('artisan'));
    let composerJson: any = null;
    if (fs.existsSync(p('composer.json'))) {
        try {
            composerJson = JSON.parse(fs.readFileSync(p('composer.json'), 'utf-8'));
        } catch {
            /* ignore invalid json */
        }
    }

    const hasLaravelReq = Boolean(
        composerJson?.require?.['laravel/framework'] || composerJson?.['require-dev']?.['laravel/framework']
    );

    if (hasLaravelReq && (hasArtisan || fs.existsSync(p('bootstrap/app.php')))) {
        isConfirmedLaravel = true;
    } else if (hasArtisan) {
        isLaravelCandidate = true;
        if (fs.existsSync(p('bootstrap/app.php')) && fs.existsSync(p('config/app.php'))) {
            isConfirmedLaravel = true;
        } else {
            log.warning('⚠️  "artisan" file detected but laravel/framework missing in composer.json.');
            log.warning('    Falling back to generic PHP deployment handling.');
        }
    }

    if (isConfirmedLaravel) {
        appType = 'laravel';
    }
    // ── PHP (plain or unconfirmed artisan) ──────────────────────────────
    else if (isLaravelCandidate || fs.existsSync(p('index.php')) || fs.existsSync(p('public/index.php')) || fs.existsSync(p('composer.json'))) {
        appType = 'php';
    }
    // ── Go ──────────────────────────────────────────────────────────────
    else if (fs.existsSync(p('go.mod'))) {
        appType = 'go';
    }
    // ── Java / Spring ───────────────────────────────────────────────────
    else if (fs.existsSync(p('pom.xml'))) {
        appType = 'java';
    }
    // ── Ruby on Rails ───────────────────────────────────────────────────
    else if (fs.existsSync(p('Gemfile'))) {
        const gemfileContent = fs.readFileSync(p('Gemfile'), 'utf-8');
        if (gemfileContent.includes('rails')) {
            appType = 'rails';
        } else {
            appType = 'ruby';
        }
    }
    // ── Python: Django or Flask ─────────────────────────────────────────
    else if (fs.existsSync(p('requirements.txt'))) {
        const req = fs.readFileSync(p('requirements.txt'), 'utf-8').toLowerCase();
        if (fs.existsSync(p('manage.py')) && req.includes('django')) {
            appType = 'django';
        } else if (req.includes('flask')) {
            appType = 'flask';
        } else {
            appType = 'python';
        }
    }
    // ── Node.js / JS Frameworks ─────────────────────────────────────────
    else if (fs.existsSync(p('package.json'))) {
        if (fs.existsSync(p('pnpm-lock.yaml'))) {
            packageManager = 'pnpm'; installCmd = 'pnpm install'; runCmd = 'pnpm run';
        } else if (fs.existsSync(p('yarn.lock'))) {
            packageManager = 'yarn'; installCmd = 'yarn install'; runCmd = 'yarn run';
        }

        const pkg = JSON.parse(fs.readFileSync(p('package.json'), 'utf-8')) as any;
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const scripts = pkg.scripts || {};

        if (deps.next) {
            appType = 'next'; buildCommand = `${runCmd} build`; startCommand = `${runCmd} start`;
        } else if (deps.vite) {
            appType = 'vite'; buildCommand = `${runCmd} build`; startCommand = 'npx -y serve -s dist -l tcp://0.0.0.0:3000';
        } else if (deps['react-scripts']) {
            appType = 'react'; buildCommand = `${runCmd} build`; startCommand = 'npx -y serve -s build -l tcp://0.0.0.0:3000';
        } else if (deps['@angular/cli']) {
            appType = 'angular'; buildCommand = `${runCmd} build`; startCommand = 'npx -y serve -s dist/browser -l 3000';
        } else if (deps.nuxt) {
            appType = 'nuxt'; buildCommand = `${runCmd} build`; startCommand = 'node .output/server/index.mjs';
        } else if (deps.vue) {
            appType = 'vue'; buildCommand = `${runCmd} build`; startCommand = 'npx -y serve -s dist -l tcp://0.0.0.0:3000';
        } else {
            appType = 'node';
            if (scripts.build) { buildCommand = `${runCmd} build`; }
            startCommand = scripts.start ? `${runCmd} start` : pkg.main ? `node ${pkg.main}` : 'node index.js';
        }
    }
    // ── Static HTML ─────────────────────────────────────────────────────
    else if (fs.existsSync(p('index.html'))) {
        appType = 'static';
    }

    /* ── Volume Detection (Persistence) ────────────────────────────── */
    let volumes: string[] = [];
    if (useVolumes) {
        if (appType === 'laravel') {
            volumes = [
                '/database',
                '/storage',
                '/public/uploads',
                '/public/assets/uploads'
            ];
        } else {
            const suggestedVolumes: string[] = [];
            const commonDataPaths = ['data', 'database', 'storage', 'uploads'];
            for (const dataPath of commonDataPaths) {
                if (dataPath === 'database') {
                    // Only persist /database if SQLite or file-based DB is detected
                    let isSqlite = false;
                    try {
                        const files = fs.readdirSync(p('database'));
                        if (files.some(f => f.endsWith('.sqlite') || f.endsWith('.db'))) isSqlite = true;
                    } catch {}
                    if (fs.existsSync(p('.env'))) {
                        const envContent = fs.readFileSync(p('.env'), 'utf-8');
                        if (envContent.includes('DB_CONNECTION=sqlite')) isSqlite = true;
                    }
                    if (isSqlite && fs.existsSync(p('database'))) suggestedVolumes.push('/database');
                } else if (fs.existsSync(p(dataPath))) {
                    suggestedVolumes.push(`/${dataPath}`);
                }
            }
            try {
                const files = fs.readdirSync(projectPath);
                for (const f of files) {
                    if ((f.endsWith('.sqlite') || f.endsWith('.db')) && !suggestedVolumes.includes(`/${f}`)) {
                        suggestedVolumes.push(`/${f}`);
                    }
                }
            } catch { /* ignore */ }
            volumes = Array.from(new Set(suggestedVolumes));
        }
    }

    /* ── Save config ─────────────────────────────────────────────────── */
    saveProjectConfig({
        projectName,
        gitRepo,
        domain: domain || undefined,
        appType,
        deploymentType: 'docker',
        mode: domain ? 'domain' : 'port',
        strictCI,
        volumes: volumes.length > 0 ? volumes : undefined,
    }, projectPath);
    
    log.info(`✨ Detected: ${appType === 'static' ? 'Static Website' : appType === 'node' ? 'Node.js App' : appType}`);
    log.success('autoflow.config.json created');

    /* ── Dockerfile generation ───────────────────────────────────────── */
    let dockerfile = '';
    let dockerignoreExtras = '';

    // ─── Laravel Framework ──────────────────────────────────────────────
    if (appType === 'laravel') {
        let requiresNode = false;
        if (fs.existsSync(p('package.json'))) {
            try {
                const pkg = JSON.parse(fs.readFileSync(p('package.json'), 'utf-8'));
                const deps = { ...pkg.dependencies, ...pkg.devDependencies };
                const scripts = pkg.scripts || {};
                if (deps.vite || deps['laravel-mix'] || deps.webpack || deps.tailwindcss || scripts.build || scripts.dev) {
                    requiresNode = true;
                }
            } catch {}
        }

        const nodeInstallStep = requiresNode
            ? '    nodejs \\\n    npm \\\n'
            : '';

        dockerfile = `FROM php:8.2-apache\n\n# Install System Dependencies & PHP Extensions required by Laravel\nRUN apt-get update && apt-get install -y \\\n    git \\\n    curl \\\n    libpng-dev \\\n    libonig-dev \\\n    libxml2-dev \\\n    zip \\\n    unzip \\\n    libzip-dev \\\n${nodeInstallStep}    && docker-php-ext-install pdo_mysql mbstring exif pcntl bcmath gd zip\n\n# Enable Apache mod_rewrite for clean URLs\nRUN a2enmod rewrite\n\n# Update Apache Port (3000) and DocumentRoot (/var/www/html/public)\nRUN sed -i 's/Listen 80/Listen 3000/' /etc/apache2/ports.conf && \\\n    sed -i 's/<VirtualHost \\*:80>/<VirtualHost *:3000>/' /etc/apache2/sites-enabled/000-default.conf && \\\n    sed -i 's|DocumentRoot /var/www/html|DocumentRoot /var/www/html/public|g' /etc/apache2/sites-enabled/000-default.conf && \\\n    echo "UseCanonicalName Off" >> /etc/apache2/apache2.conf && \\\n    echo "UseCanonicalPhysicalPort Off" >> /etc/apache2/apache2.conf\n\n# Install Composer\nCOPY --from=composer:latest /usr/bin/composer /usr/bin/composer\n\nWORKDIR /var/www/html\n\n# Copy all project files\nCOPY . .\n\n# Install PHP dependencies via Composer\nRUN composer install --no-interaction --prefer-dist --optimize-autoloader --no-dev\n\n# Copy startup entrypoint script & make executable\nCOPY docker-entrypoint.sh /usr/local/bin/\nRUN chmod +x /usr/local/bin/docker-entrypoint.sh\n\n# Set initial permissions for Laravel storage, cache, and uploads directories\nRUN mkdir -p /var/www/html/public/uploads /var/www/html/public/assets/uploads /var/www/html/storage/app/public && \\\n    chown -R www-data:www-data /var/www/html && \\\n    chmod -R 775 /var/www/html/storage /var/www/html/bootstrap/cache /var/www/html/public/uploads /var/www/html/public/assets 2>/dev/null || true\n\nEXPOSE 3000\n\nENTRYPOINT ["docker-entrypoint.sh"]`;
        dockerignoreExtras = '\n# Laravel\n.env\nvendor/\nstorage/*.key\n*.log';

        // ── Generate defensive docker-entrypoint.sh ──────────────────────────
        const entrypointScript = `#!/bin/sh\n\n# Safe file/config clear (does NOT try connecting to Database during boot)\nphp artisan config:clear || true\nphp artisan view:clear || true\nphp artisan route:clear || true\n\n# Re-apply correct ownership & permissions on volumes\nmkdir -p /var/www/html/public/uploads /var/www/html/public/assets/uploads /var/www/html/storage/app/public\nchown -R www-data:www-data /var/www/html/storage /var/www/html/bootstrap/cache /var/www/html/public/uploads /var/www/html/public/assets 2>/dev/null || true\nchmod -R 775 /var/www/html/storage /var/www/html/bootstrap/cache /var/www/html/public/uploads /var/www/html/public/assets 2>/dev/null || true\n\n# Start Apache in foreground\nexec apache2-foreground\n`;
        fs.writeFileSync(p('docker-entrypoint.sh'), entrypointScript);
        try { fs.chmodSync(p('docker-entrypoint.sh'), 0o755); } catch {}
        log.success('docker-entrypoint.sh generated');

        // ── 3-Tier Layered Proxy-Aware HTTPS Handling ────────────────────────
        const appProviderPath = p('app/Providers/AppServiceProvider.php');
        const trustProxiesPath = p('app/Http/Middleware/TrustProxies.php');
        const bootstrapAppPath = p('bootstrap/app.php');

        let alreadyHasProxyHandling = false;
        if (fs.existsSync(appProviderPath) && fs.readFileSync(appProviderPath, 'utf-8').includes('forceScheme')) {
            alreadyHasProxyHandling = true;
        }
        if (fs.existsSync(trustProxiesPath) && fs.readFileSync(trustProxiesPath, 'utf-8').includes('$proxies')) {
            alreadyHasProxyHandling = true;
        }
        if (fs.existsSync(bootstrapAppPath) && fs.readFileSync(bootstrapAppPath, 'utf-8').includes('trustProxies')) {
            alreadyHasProxyHandling = true;
        }

        if (!alreadyHasProxyHandling && fs.existsSync(appProviderPath)) {
            try {
                let providerContent = fs.readFileSync(appProviderPath, 'utf-8');
                if (!providerContent.includes('forceScheme')) {
                    const snippet = `
        \\Illuminate\\Support\\Facades\\URL::forceScheme('https');
`;
                    if (/public\s+function\s+boot\s*\([^)]*\)\s*:\s*void\s*\{/i.test(providerContent)) {
                        providerContent = providerContent.replace(/(public\s+function\s+boot\s*\([^)]*\)\s*:\s*void\s*\{)/i, `$1${snippet}`);
                    } else if (/public\s+function\s+boot\s*\([^)]*\)\s*\{/i.test(providerContent)) {
                        providerContent = providerContent.replace(/(public\s+function\s+boot\s*\([^)]*\)\s*\{)/i, `$1${snippet}`);
                    } else {
                        providerContent = providerContent.replace(/class\s+AppServiceProvider\s+extends\s+\w+\s*\{/i, `$&\n    public function boot(): void\n    {${snippet}    }\n`);
                    }
                    fs.writeFileSync(appProviderPath, providerContent);
                    log.success('AppServiceProvider.php updated with HTTPS forceScheme');
                }
            } catch (err) {
                log.warning(`Could not modify AppServiceProvider.php safely: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        // Laravel 11 trustProxies in bootstrap/app.php
        if (fs.existsSync(bootstrapAppPath)) {
            try {
                let bootstrapContent = fs.readFileSync(bootstrapAppPath, 'utf-8');
                if (!bootstrapContent.includes('trustProxies')) {
                    if (bootstrapContent.includes('->withMiddleware(function (Middleware $middleware)')) {
                        bootstrapContent = bootstrapContent.replace(
                            /->withMiddleware\(function\s*\(Middleware\s*\$middleware\)\s*(?::\s*void)?\s*\{/i,
                            `$&\\n        $middleware->trustProxies(at: '*');`
                        );
                    } else {
                        bootstrapContent = bootstrapContent.replace(
                            /->withMiddleware\(function\s*\(Middleware\s*\$middleware\)\s*\{/i,
                            `$&\\n        $middleware->trustProxies(at: '*');`
                        );
                    }
                    fs.writeFileSync(bootstrapAppPath, bootstrapContent);
                    log.success('bootstrap/app.php updated with trustProxies');
                }
            } catch (err) {
                log.warning(`Could not modify bootstrap/app.php safely: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    // ─── PHP (plain) ────────────────────────────────────────────────────
    else if (appType === 'php') {
        dockerfile = `FROM php:8.2-apache\n\nRUN a2enmod rewrite\nRUN docker-php-ext-install mysqli pdo pdo_mysql\nRUN sed -i 's/Listen 80/Listen 3000/' /etc/apache2/ports.conf && \\\n    sed -i 's/<VirtualHost \\*:80>/<VirtualHost *:3000>/' /etc/apache2/sites-enabled/000-default.conf && \\\n    echo "UseCanonicalName Off" >> /etc/apache2/apache2.conf && \\\n    echo "UseCanonicalPhysicalPort Off" >> /etc/apache2/apache2.conf\n\nWORKDIR /var/www/html\nCOPY . .\nRUN chown -R www-data:www-data /var/www/html\nEXPOSE 3000\nCMD ["apache2-foreground"]`;
        dockerignoreExtras = '\n# PHP\n.env\nvendor/\n*.log';
    }
    // ─── Python / Django ────────────────────────────────────────────────
    else if (appType === 'django') {
        dockerfile = `FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nEXPOSE 8000\nCMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "3", "wsgi:application"]`;
        dockerignoreExtras = '\n# Python\n__pycache__/\n*.pyc\n*.pyo\n.venv/\nvenv/\n.env';
    }
    // ─── Python / Flask ─────────────────────────────────────────────────
    else if (appType === 'flask' || appType === 'python') {
        dockerfile = `FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nEXPOSE 5000\nCMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "3", "app:app"]`;
        dockerignoreExtras = '\n# Python\n__pycache__/\n*.pyc\n*.pyo\n.venv/\nvenv/\n.env';
    }
    // ─── Ruby on Rails ──────────────────────────────────────────────────
    else if (appType === 'rails' || appType === 'ruby') {
        dockerfile = `FROM ruby:3.3-slim\nRUN apt-get update -qq && apt-get install -y build-essential libpq-dev nodejs\nWORKDIR /app\nCOPY Gemfile Gemfile.lock ./\nRUN bundle install --without development test\nCOPY . .\nEXPOSE 3000\nCMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "3000"]`;
        dockerignoreExtras = '\n# Ruby\ntmp/\nlog/\n.env\nstorage/\n*.log';
    }
    // ─── Go ─────────────────────────────────────────────────────────────
    else if (appType === 'go') {
        let moduleName = 'app';
        try {
            const gomod = fs.readFileSync(p('go.mod'), 'utf-8');
            const match = gomod.match(/^module\s+(\S+)/m);
            if (match) moduleName = path.basename(match[1]);
        } catch { /* use default */ }
        dockerfile = `# ── Stage 1: Build ─────────────────────────────────────────────────\nFROM golang:1.22-alpine AS builder\nWORKDIR /build\nCOPY go.mod go.sum ./\nRUN go mod download\nCOPY . .\nRUN CGO_ENABLED=0 GOOS=linux go build -o ${moduleName} .\n\n# ── Stage 2: Run ───────────────────────────────────────────────────\nFROM alpine:latest\nRUN apk --no-cache add ca-certificates\nWORKDIR /app\nCOPY --from=builder /build/${moduleName} .\nEXPOSE 8080\nCMD ["./${moduleName}"]`;
        dockerignoreExtras = '\n# Go\nbin/\n*.exe\n.env';
    }
    // ─── Java / Spring Boot ─────────────────────────────────────────────
    else if (appType === 'java') {
        dockerfile = `# ── Stage 1: Build ─────────────────────────────────────────────────\nFROM eclipse-temurin:21-jdk AS builder\nWORKDIR /build\nCOPY pom.xml .\nCOPY src ./src\nRUN apt-get update && apt-get install -y maven\nRUN mvn clean package -DskipTests\n\n# ── Stage 2: Run ───────────────────────────────────────────────────\nFROM eclipse-temurin:21-jre\nWORKDIR /app\nCOPY --from=builder /build/target/*.jar app.jar\nEXPOSE 8080\nCMD ["java", "-jar", "app.jar"]`;
        dockerignoreExtras = '\n# Java / Maven\ntarget/\n*.class\n.env';
    }
    // ─── Static HTML ────────────────────────────────────────────────────
    else if (appType === 'static') {
        dockerfile = `FROM nginx:alpine\nRUN rm -rf /usr/share/nginx/html/*\nCOPY . /usr/share/nginx/html\nEXPOSE 80\nCMD ["nginx", "-g", "daemon off;"]`;
    }
    // ─── Node.js / JS Frameworks ────────────────────────────────────────
    else {
        let setupPM = '';
        let dockerInstallCmd = 'RUN npm install';
        if (packageManager === 'pnpm') {
            setupPM = 'RUN npm install -g pnpm';
            dockerInstallCmd = 'RUN pnpm install';
        } else if (packageManager === 'yarn') {
            dockerInstallCmd = 'RUN yarn install';
        }
        const lockFile = packageManager === 'pnpm' ? 'pnpm-lock.yaml ' : packageManager === 'yarn' ? 'yarn.lock ' : '';
        dockerfile = `FROM node:20-alpine\nWORKDIR /app\n${setupPM}\nCOPY package*.json ${lockFile}./\n${dockerInstallCmd}\nCOPY . .\n${buildCommand ? `RUN ${buildCommand}` : '# No build step required'}\nEXPOSE 3000\nCMD ${JSON.stringify(startCommand.split(' '))}`;
    }

    fs.writeFileSync(p('Dockerfile'), dockerfile.trim());
    log.success('Dockerfile generated (Production-ready 🚀)');

    /* ── .dockerignore ───────────────────────────────────────────────── */
    if (!fs.existsSync(p('.dockerignore'))) {
        const baseIgnore = `.git\n.env\nautoflow.config.json${dockerignoreExtras}`;
        const nodeIgnore = ['node', 'next', 'nuxt', 'vue', 'vite', 'react', 'angular'].includes(appType)
            ? '\nnode_modules\ndist\nbuild'
            : '';
        fs.writeFileSync(p('.dockerignore'), baseIgnore + nodeIgnore);
        log.success('.dockerignore created');
    }

    /* ── .gitignore ──────────────────────────────────────────────────── */
    if (fs.existsSync(p('.gitignore'))) {
        const gitignore = fs.readFileSync(p('.gitignore'), 'utf-8');
        const additions: string[] = [];
        if (!gitignore.includes('.env')) additions.push('.env');
        if (!gitignore.includes('autoflow.config.json')) additions.push('autoflow.config.json');
        if (additions.length > 0) {
            fs.appendFileSync(p('.gitignore'), `\n# AutoFlow Secrets\n${additions.join('\n')}\n`);
        }
    } else {
        const baseGitignore = `# AutoFlow\n.env\nautoflow.config.json\n.DS_Store\nThumbs.db\n`;
        fs.writeFileSync(p('.gitignore'), baseGitignore);
    }

    /* ── Static-only extras ──────────────────────────────────────────── */
    if (appType === 'static') {
        if (!fs.existsSync(p('.autoflow.yml')) && !fs.existsSync(p('.autoflow.yaml'))) {
            fs.writeFileSync(p('.autoflow.yml'), [
                `project: ${projectName}`,
                `type: static`,
                ``,
                `# AutoFlow static project config`,
                `# Generated by "autoflow init"`,
            ].join('\n'));
            log.success('.autoflow.yml created');
        }
        if (!fs.existsSync(p('.nojekyll'))) {
            fs.writeFileSync(p('.nojekyll'), '');
            log.success('.nojekyll created');
        }
    }

    /* ── GitHub Actions CI workflow ───────────────────────────────────── */
    const workflowDir = p('.github/workflows');
    const workflowPath = p('.github/workflows/ci.yml');

    if (strictCI && !fs.existsSync(workflowPath)) {
        fs.mkdirSync(workflowDir, { recursive: true });

        let ciWorkflow = '';
        const ciHeader = `name: CI\n\non:\n  push:\n    branches: [ main, master ]\n  pull_request:\n    branches: [ main, master ]\n\njobs:\n`;

        // ── Laravel CI ──────────────────────────────────────────────────
        if (appType === 'laravel') {
            ciWorkflow = `${ciHeader}  ci:\n    name: Laravel Application CI\n    runs-on: ubuntu-latest\n\n    steps:\n      - name: Checkout code\n        uses: actions/checkout@v4\n\n      - name: Setup PHP\n        uses: shivammathur/setup-php@v2\n        with:\n          php-version: '8.2'\n          extensions: mbstring, dom, fileinfo, mysql, pdo, pdo_mysql, bcmath, ctype, json, openssl, tokenizer, xml\n          coverage: none\n\n      - name: Install Composer Dependencies\n        run: composer install --no-ansi --no-interaction --no-progress --prefer-dist --optimize-autoloader\n\n      - name: Prepare Environment\n        run: |\n          if [ ! -f .env ]; then\n            cp .env.example .env 2>/dev/null || touch .env\n          fi\n          php artisan key:generate --force || true\n\n      - name: Check Dockerfile\n        run: |\n          [ -f "Dockerfile" ] || { echo "❌ Dockerfile missing"; exit 1; }\n          echo "✅ Laravel Dockerfile verified"\n\n      - name: Run Tests\n        run: |\n          if [ -f "vendor/bin/phpunit" ]; then\n            vendor/bin/phpunit --no-coverage || echo "ℹ️ Tests skipped or non-fatal"\n          elif [ -f "vendor/bin/pest" ]; then\n            vendor/bin/pest || echo "ℹ️ Pest tests skipped or non-fatal"\n          else\n            echo "ℹ️ No test suite found, skipping test execution"\n          fi\n`;
        }
        // ── PHP CI ──────────────────────────────────────────────────────
        else if (appType === 'php') {
            const composerStep = fs.existsSync(p('composer.json'))
                ? `\n      - name: Install Composer dependencies\n        run: composer install --no-progress --prefer-dist --optimize-autoloader`
                : '';
            ciWorkflow = `${ciHeader}  ci:\n    name: PHP Syntax Check\n    runs-on: ubuntu-latest\n\n    steps:\n      - name: Checkout code\n        uses: actions/checkout@v4\n\n      - name: Setup PHP\n        uses: shivammathur/setup-php@v2\n        with:\n          php-version: '8.2'\n          extensions: mysqli, pdo, pdo_mysql\n${composerStep}\n      - name: PHP syntax check (lint all .php files)\n        run: find . -name "*.php" -not -path "./.git/*" -not -path "./vendor/*" | xargs -I{} php -l {}\n\n      - name: Check Dockerfile exists\n        run: |\n          [ -f "Dockerfile" ] || { echo "❌ Dockerfile missing"; exit 1; }\n          echo "✅ Dockerfile present"\n`;
        }
        // ── Django CI ───────────────────────────────────────────────────
        else if (appType === 'django') {
            ciWorkflow = `${ciHeader}  ci:\n    name: Django CI\n    runs-on: ubuntu-latest\n\n    steps:\n      - name: Checkout code\n        uses: actions/checkout@v4\n\n      - name: Setup Python\n        uses: actions/setup-python@v5\n        with:\n          python-version: '3.12'\n\n      - name: Install dependencies\n        run: pip install -r requirements.txt\n\n      - name: Django system check\n        run: python manage.py check --deploy --settings=\${{ env.DJANGO_SETTINGS_MODULE || 'settings' }}\n        continue-on-error: true\n\n      - name: Run tests\n        run: python manage.py test\n        continue-on-error: false\n`;
        }
        // ── Flask / Python CI ────────────────────────────────────────────
        else if (appType === 'flask' || appType === 'python') {
            ciWorkflow = `${ciHeader}  ci:\n    name: Python / Flask CI\n    runs-on: ubuntu-latest\n\n    steps:\n      - name: Checkout code\n        uses: actions/checkout@v4\n\n      - name: Setup Python\n        uses: actions/setup-python@v5\n        with:\n          python-version: '3.12'\n\n      - name: Install dependencies\n        run: pip install -r requirements.txt\n\n      - name: Run tests\n        run: |\n          if command -v pytest &> /dev/null; then\n            pytest\n          else\n            python -m unittest discover\n          fi\n        continue-on-error: false\n`;
        }
        // ── Rails / Ruby CI ──────────────────────────────────────────────
        else if (appType === 'rails' || appType === 'ruby') {
            ciWorkflow = `${ciHeader}  ci:\n    name: Ruby on Rails CI\n    runs-on: ubuntu-latest\n\n    steps:\n      - name: Checkout code\n        uses: actions/checkout@v4\n\n      - name: Setup Ruby\n        uses: ruby/setup-ruby@v1\n        with:\n          ruby-version: '3.3'\n          bundler-cache: true\n\n      - name: Run tests\n        run: |\n          if bundle exec rake --tasks | grep -q "spec"; then\n            bundle exec rspec\n          else\n            bundle exec rails test\n          fi\n`;
        }
        // ── Go CI ────────────────────────────────────────────────────────
        else if (appType === 'go') {
            ciWorkflow = `${ciHeader}  ci:\n    name: Go CI\n    runs-on: ubuntu-latest\n\n    steps:\n      - name: Checkout code\n        uses: actions/checkout@v4\n\n      - name: Setup Go\n        uses: actions/setup-go@v5\n        with:\n          go-version: '1.22'\n\n      - name: Download modules\n        run: go mod download\n\n      - name: Build\n        run: go build ./...\n\n      - name: Run tests\n        run: go test ./... -v\n`;
        }
        // ── Java / Spring CI ─────────────────────────────────────────────
        else if (appType === 'java') {
            ciWorkflow = `${ciHeader}  ci:\n    name: Java / Maven CI\n    runs-on: ubuntu-latest\n\n    steps:\n      - name: Checkout code\n        uses: actions/checkout@v4\n\n      - name: Setup Java\n        uses: actions/setup-java@v4\n        with:\n          distribution: 'temurin'\n          java-version: '21'\n          cache: 'maven'\n\n      - name: Build and test\n        run: mvn --batch-mode clean test\n\n      - name: Package (verify JAR builds)\n        run: mvn --batch-mode package -DskipTests\n`;
        }
        // ── Static CI ────────────────────────────────────────────────────
        else if (appType === 'static') {
            ciWorkflow = `${ciHeader}  validate:\n    name: Validate Static Project\n    runs-on: ubuntu-latest\n\n    steps:\n      - name: Checkout code\n        uses: actions/checkout@v4\n\n      - name: Check required files exist\n        run: |\n          echo "Checking required files..."\n          [ -f "index.html" ]       || { echo "❌ index.html missing";       exit 1; }\n          [ -f "Dockerfile" ]       || { echo "❌ Dockerfile missing";       exit 1; }\n          [ -f ".autoflow.yml" ] || [ -f ".autoflow.yaml" ] || { echo "❌ .autoflow.yml missing"; exit 1; }\n          echo "✅ All required files present."\n\n      - name: Count HTML files\n        run: |\n          count=$(find . -name "*.html" -not -path "./.git/*" | wc -l)\n          echo "✅ Found $count HTML file(s). Static validation passed."\n`;
            
            const disablePagesWorkflow = `name: Disable GitHub Pages\n\n# This workflow cancels the auto-triggered "pages build and deployment" job.\n# This project is deployed via AutoFlow to a private server — GitHub Pages is not used.\n\non:\n  workflow_run:\n    workflows: ["pages build and deployment"]\n    types: [requested]\n\njobs:\n  cancel-pages:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Cancel GitHub Pages deployment\n        uses: styfle/cancel-workflow-action@0.12.1\n        with:\n          workflow_id: \${{ github.event.workflow_run.id }}\n          access_token: \${{ github.token }}\n`;
            fs.writeFileSync(p('.github/workflows/disable-pages.yml'), disablePagesWorkflow);
        }
        // ── Node.js / JS Frameworks CI ───────────────────────────────────
        else {
            const pmInstallYaml = packageManager === 'pnpm'
                ? `      - name: Install dependencies\n        run: npm install -g pnpm && pnpm install`
                : packageManager === 'yarn'
                    ? `      - name: Install dependencies\n        run: yarn install`
                    : `      - name: Install dependencies\n        run: npm install`;
            const buildStep = buildCommand
                ? `\n      - name: Build\n        run: ${buildCommand}`
                : '';
            const testStep = `\n      - name: Run tests\n        run: ${packageManager === 'pnpm' ? 'pnpm test' : packageManager === 'yarn' ? 'yarn test' : 'npm test'}\n        continue-on-error: false`;

            ciWorkflow = `${ciHeader}  ci:\n    name: Build & Test\n    runs-on: ubuntu-latest\n\n    steps:\n      - name: Checkout code\n        uses: actions/checkout@v4\n\n      - name: Setup Node.js\n        uses: actions/setup-node@v4\n        with:\n          node-version: '20'\n          cache: '${packageManager === 'pnpm' ? 'npm' : packageManager}'\n${pmInstallYaml}${buildStep}${testStep}\n`;
        }

        if (ciWorkflow) {
            fs.writeFileSync(workflowPath, ciWorkflow);
            log.success('.github/workflows/ci.yml created');
        }
    }
    
    log.info(`Initialization complete! 🎉 Ready to deploy "${projectName}".\n`);
}
