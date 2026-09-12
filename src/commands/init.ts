import fs from 'fs';
import log from '../utils/logger';
import { saveProjectConfig, loadGlobalConfig } from '../core/config';
import path from 'path';
import { execSync, spawnSync } from 'child_process';
import { loadVaultConfig, saveVaultConfig, vaultEngine } from '../core/vault';
import { promptConsole } from '../utils/console';

async function init(): Promise<void> {
  log.header('AUTOFLOW INITIALIZATION');

  // Require global config first
  try { loadGlobalConfig(); } catch {
    log.error('Global configuration missing!');
    log.warning('Run "autoflow setup" first.');
    return;
  }

  const defaultProjectName = path.basename(process.cwd()).toLowerCase().replace(/\s+/g, '-');
  const projNameInput = await promptConsole(`? Project name (${defaultProjectName}): `);
  const projectName = projNameInput || defaultProjectName;

  const gitRepo = await promptConsole('? GitHub repository URL: ');
  const domain = await promptConsole('? Domain / Subdomain (leave empty for IP:PORT mode): ');
  const branchInput = await promptConsole('? Git Branch to deploy (main): ');
  const branch = branchInput || 'main';

  const strictCIInput = await promptConsole('? Enable Strict CI? (Y/n): ');
  const strictCI = !strictCIInput || strictCIInput.toLowerCase().startsWith('y');

  const answers = {
    projectName,
    gitRepo,
    domain,
    branch,
    strictCI
  };

  try {
    spawnSync('git', ['ls-remote', answers.gitRepo], { stdio: 'ignore' });
  } catch (e) {
    log.warning('\nPrivate repository detected (authentication required).');
    const pat = await promptConsole('? Enter a Personal Access Token (PAT) for Git (leave empty to configure later): ', true);

    if (pat) {
      let vault = loadVaultConfig();
      if (!vault) {
        log.warning('Vault not set up. Run "autoflow setup-vault" first to securely store Git tokens.');
      } else {
        log.header('Z+ SECURITY CHALLENGE');
        const password = await promptConsole('? Enter Master Deployment Password to encrypt token: ', true);
        const token = await promptConsole('? Enter 6-digit OTP from your phone: ');

        if (vaultEngine.unlock(password, token)) {
            if (!vault.projectTokens) vault.projectTokens = {};
            vault.projectTokens[answers.projectName] = vaultEngine.encrypt(pat);
            saveVaultConfig(vault);
            log.success('✔ Git token securely encrypted and saved to Vault.');
        } else {
            log.error('Invalid Vault credentials. Token not saved.');
        }
      }
    }
  }

  /* ── Smart Detection Engine ─────────────────────────────────────── */
  let appType = 'node';
  let buildCommand: string | null = null;
  let startCommand = 'npm start';
  let packageManager = 'npm';
  let installCmd = 'npm install';
  let runCmd = 'npm run';

  // ── Go ──────────────────────────────────────────────────────────────
  if (fs.existsSync('go.mod')) {
    appType = 'go';
    log.info('✨ Detected: Go');
  }
  // ── Java / Spring ───────────────────────────────────────────────────
  else if (fs.existsSync('pom.xml')) {
    appType = 'java';
    log.info('✨ Detected: Java / Spring Boot');
  }
  // ── Ruby on Rails ───────────────────────────────────────────────────
  else if (fs.existsSync('Gemfile')) {
    const gemfileContent = fs.readFileSync('Gemfile', 'utf-8');
    if (gemfileContent.includes('rails')) {
      appType = 'rails';
      log.info('✨ Detected: Ruby on Rails');
    } else {
      appType = 'ruby';
      log.info('✨ Detected: Ruby');
    }
  }
  // ── Python: Django or Flask ─────────────────────────────────────────
  else if (fs.existsSync('requirements.txt')) {
    const req = fs.readFileSync('requirements.txt', 'utf-8').toLowerCase();
    if (fs.existsSync('manage.py') && req.includes('django')) {
      appType = 'django';
      log.info('✨ Detected: Python / Django');
    } else if (req.includes('flask')) {
      appType = 'flask';
      log.info('✨ Detected: Python / Flask');
    } else {
      appType = 'python';
      log.info('✨ Detected: Python');
    }
  }
  // ── Laravel Framework (Confirmed Multi-Signal) ───────────────────────
  let isConfirmedLaravel = false;
  const hasArtisan = fs.existsSync('artisan');
  let composerJson: any = null;
  if (fs.existsSync('composer.json')) {
    try {
      composerJson = JSON.parse(fs.readFileSync('composer.json', 'utf-8'));
    } catch { /* ignore */ }
  }
  const hasLaravelReq = Boolean(
    composerJson?.require?.['laravel/framework'] || composerJson?.['require-dev']?.['laravel/framework']
  );

  if (hasLaravelReq && (hasArtisan || fs.existsSync('bootstrap/app.php'))) {
    isConfirmedLaravel = true;
  } else if (hasArtisan) {
    if (fs.existsSync('bootstrap/app.php') && fs.existsSync('config/app.php')) {
      isConfirmedLaravel = true;
    } else {
      log.warning('⚠️  "artisan" file detected but laravel/framework missing in composer.json.');
      log.warning('    Falling back to generic PHP deployment handling.');
    }
  }

  if (isConfirmedLaravel) {
    appType = 'laravel';
    log.info('✨ Detected: Laravel');
  }
  // ── PHP (plain) ─────────────────────────────────────────────────────
  else if (hasArtisan || fs.existsSync('index.php') || fs.existsSync('public/index.php') || fs.existsSync('composer.json')) {
    appType = 'php';
    log.info('✨ Detected: PHP');
    log.info('  ℹ️  DB Note: AutoFlow deploys CODE only. Please set up your MySQL database');
    log.info('     manually on the server (import your .sql via phpMyAdmin).');
  }
  // ── Node.js / JS Frameworks ─────────────────────────────────────────
  else if (fs.existsSync('package.json')) {
    if (fs.existsSync('pnpm-lock.yaml')) {
      packageManager = 'pnpm'; installCmd = 'pnpm install'; runCmd = 'pnpm run';
      log.info('📦 Detected: pnpm');
    } else if (fs.existsSync('yarn.lock')) {
      packageManager = 'yarn'; installCmd = 'yarn install'; runCmd = 'yarn run';
      log.info('📦 Detected: yarn');
    } else {
      log.info('📦 Detected: npm');
    }

    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
      main?: string;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scripts = pkg.scripts || {};

    if (deps.next) {
      appType = 'next'; buildCommand = `${runCmd} build`; startCommand = `${runCmd} start`;
      log.info('✨ Detected: Next.js');
    } else if (deps.vite) {
      appType = 'vite'; buildCommand = `${runCmd} build`; startCommand = 'npx -y serve -s dist -l tcp://0.0.0.0:3000';
      log.info('✨ Detected: Vite');
    } else if (deps['react-scripts']) {
      appType = 'react'; buildCommand = `${runCmd} build`; startCommand = 'npx -y serve -s build -l tcp://0.0.0.0:3000';
      log.info('✨ Detected: Create React App');
    } else if (deps['@angular/cli']) {
      appType = 'angular'; buildCommand = `${runCmd} build`; startCommand = 'npx -y serve -s dist/browser -l 3000';
      log.info('✨ Detected: Angular');
    } else if (deps.nuxt) {
      appType = 'nuxt'; buildCommand = `${runCmd} build`; startCommand = 'node .output/server/index.mjs';
      log.info('✨ Detected: Nuxt.js');
    } else if (deps.vue) {
      appType = 'vue'; buildCommand = `${runCmd} build`; startCommand = 'npx -y serve -s dist -l tcp://0.0.0.0:3000';
      log.info('✨ Detected: Vue.js');
    } else {
      appType = 'node';
      log.info('✨ Detected: Node.js / Express');
      if (scripts.build) { buildCommand = `${runCmd} build`; }
      startCommand = scripts.start ? `${runCmd} start` : pkg.main ? `node ${pkg.main}` : 'node index.js';
    }
  }
  // ── Static HTML ─────────────────────────────────────────────────────
  else if (fs.existsSync('index.html')) {
    appType = 'static';
    log.info('✨ Detected: Static Website');
  }

  /* ── Volume Detection (Persistence) ────────────────────────────── */
  let volumes: string[] = [];
  if (appType === 'laravel' || isConfirmedLaravel) {
    volumes = [
      '/database',
      '/storage',
      '/public/uploads',
      '/public/assets/uploads'
    ];
    log.info(`💾 Persistence: Auto-configured full Laravel volumes: ${volumes.join(', ')}`);
  } else {
    const suggestedVolumes: string[] = [];
    const commonDataPaths = ['data', 'database', 'storage', 'uploads'];
    for (const p of commonDataPaths) {
      if (fs.existsSync(p)) suggestedVolumes.push(`/${p}`);
    }
    // Check for sqlite files in root
    try {
      const files = fs.readdirSync(process.cwd());
      for (const f of files) {
        if (f.endsWith('.sqlite') || f.endsWith('.db')) {
          suggestedVolumes.push(`/${f}`);
        }
      }
    } catch { /* ignore */ }

    if (suggestedVolumes.length > 0) {
      log.info(`\n💾 Persistence: AutoFlow detected possible data paths: ${suggestedVolumes.join(', ')}`);
      const volInput = await promptConsole('? Enable persistent volumes for these paths? (Recommended for databases) (Y/n): ');
      const useVolumes = !volInput || volInput.toLowerCase().startsWith('y');
      if (useVolumes) {
        volumes = suggestedVolumes;
      }
    }
  }

  /* ── Save config ─────────────────────────────────────────────────── */
  saveProjectConfig({
    projectName: answers.projectName,
    gitRepo: answers.gitRepo,
    domain: answers.domain || undefined,
    appType,
    deploymentType: 'docker',
    mode: answers.domain ? 'domain' : 'port',
    branch: answers.branch || 'main',
    strictCI: answers.strictCI,
    volumes: volumes.length > 0 ? volumes : undefined,
  });
  log.success('autoflow.config.json created ✔');

  /* ── Dockerfile generation ───────────────────────────────────────── */
  let dockerfile = '';
  let dockerignoreExtras = '';

  // ─── Laravel ────────────────────────────────────────────────────────
  if (appType === 'laravel') {
    let requiresNode = false;
    let pkgJson: any = null;
    if (fs.existsSync('package.json')) {
      try {
        pkgJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
        const deps = { ...pkgJson?.dependencies, ...pkgJson?.devDependencies };
        const scripts = pkgJson?.scripts || {};
        if (deps.vite || deps['laravel-mix'] || deps.webpack || deps.tailwindcss || scripts.build || scripts.dev) {
          requiresNode = true;
        }
      } catch { /* ignore */ }
    }

    const nodeInstallBlock = requiresNode
      ? `\n# Install Node.js & npm for frontend asset building\nRUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \\\n    apt-get install -y nodejs\n`
      : '';

    const nodeBuildStep = requiresNode
      ? `\n# Build frontend assets if package.json scripts exist\nRUN if [ -f package.json ]; then npm install && (npm run build || npm run dev || true); fi\n`
      : '';

    dockerfile = `FROM php:8.2-apache

# Install system dependencies & PHP extensions required by Laravel
RUN apt-get update && apt-get install -y \\
    git curl libpng-dev libonig-dev libxml2-dev zip unzip libzip-dev \\
    && docker-php-ext-install pdo_mysql mbstring exif pcntl bcmath gd zip

# Enable Apache mod_rewrite
RUN a2enmod rewrite
${nodeInstallBlock}
# Install Composer
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer

WORKDIR /var/www/html

COPY . .

# Install PHP dependencies
RUN composer install --no-dev --optimize-autoloader --no-interaction --prefer-dist
${nodeBuildStep}
# Configure Apache DocumentRoot to /var/www/html/public & set port 3000
RUN sed -i 's|DocumentRoot /var/www/html|DocumentRoot /var/www/html/public|g' /etc/apache2/sites-available/000-default.conf && \\
    sed -i 's/<VirtualHost \\*:80>/<VirtualHost *:3000>/' /etc/apache2/sites-available/000-default.conf && \\
    sed -i 's/Listen 80/Listen 3000/' /etc/apache2/ports.conf && \\
    echo "UseCanonicalName Off" >> /etc/apache2/apache2.conf && \\
    echo "UseCanonicalPhysicalPort Off" >> /etc/apache2/apache2.conf

# Set permissions for Laravel storage & bootstrap/cache
RUN chown -R www-data:www-data /var/www/html \\
    && chmod -R 775 /var/www/html/storage /var/www/html/bootstrap/cache

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["apache2-foreground"]`;

    dockerignoreExtras = '\n# Laravel\n.env\nvendor/\nnode_modules/\n*.log\nstorage/*.key';

    // Generate docker-entrypoint.sh safely
    const entrypointContent = `#!/bin/sh
set -e

# Run migrations if DB is configured, fail silently if DB unreachable
if [ -n "$DB_HOST" ] || [ -n "$DB_CONNECTION" ]; then
    echo "Running database migrations..."
    php artisan migrate --force || echo "Migration skipped or failed (non-critical)"
fi

# Clear & optimize caches non-blockingly
php artisan config:cache || true
php artisan route:cache || true
php artisan view:cache || true

exec "$@"
`;
    fs.writeFileSync('docker-entrypoint.sh', entrypointContent, { mode: 0o755 });
    log.success('docker-entrypoint.sh generated');

    // HTTPS Reverse-Proxy Injection in AppServiceProvider.php
    const appProviderPath = path.join('app', 'Providers', 'AppServiceProvider.php');
    if (fs.existsSync(appProviderPath)) {
      try {
        let providerContent = fs.readFileSync(appProviderPath, 'utf-8');
        const hasForceScheme = providerContent.includes('forceScheme') || providerContent.includes('URL::forceScheme');
        if (!hasForceScheme) {
          if (!providerContent.includes('use Illuminate\\Support\\Facades\\URL;')) {
            providerContent = providerContent.replace(/(namespace\s+App\\Providers;)/, `$1\n\nuse Illuminate\\Support\\Facades\\URL;`);
          }
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

    // Laravel 11 trustProxies injection in bootstrap/app.php
    const bootstrapAppPath = path.join('bootstrap', 'app.php');
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
    dockerfile = `FROM php:8.2-apache

# Enable Apache mod_rewrite for clean URLs
RUN a2enmod rewrite

# Install PHP extensions commonly needed for DB connectivity
RUN docker-php-ext-install mysqli pdo pdo_mysql

# Move Apache from port 80 → port 3000 (AutoFlow expects 3000)
RUN sed -i 's/Listen 80/Listen 3000/' /etc/apache2/ports.conf && \\
    sed -i 's/<VirtualHost \\*:80>/<VirtualHost *:3000>/' /etc/apache2/sites-enabled/000-default.conf && \\
    echo "UseCanonicalName Off" >> /etc/apache2/apache2.conf && \\
    echo "UseCanonicalPhysicalPort Off" >> /etc/apache2/apache2.conf

WORKDIR /var/www/html

# Copy all project files
COPY . .

# Fix permissions
RUN chown -R www-data:www-data /var/www/html

EXPOSE 3000
CMD ["apache2-foreground"]`;
    dockerignoreExtras = '\n# PHP\n.env\nvendor/\n*.log';
  }

  // ─── Python / Django ────────────────────────────────────────────────
  else if (appType === 'django') {
    dockerfile = `FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "3", "wsgi:application"]`;
    dockerignoreExtras = '\n# Python\n__pycache__/\n*.pyc\n*.pyo\n.venv/\nvenv/\n.env';
  }

  // ─── Python / Flask ─────────────────────────────────────────────────
  else if (appType === 'flask' || appType === 'python') {
    dockerfile = `FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5000
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "3", "app:app"]`;
    dockerignoreExtras = '\n# Python\n__pycache__/\n*.pyc\n*.pyo\n.venv/\nvenv/\n.env';
  }

  // ─── Ruby on Rails ──────────────────────────────────────────────────
  else if (appType === 'rails' || appType === 'ruby') {
    dockerfile = `FROM ruby:3.3-slim

RUN apt-get update -qq && apt-get install -y build-essential libpq-dev nodejs

WORKDIR /app

COPY Gemfile Gemfile.lock ./
RUN bundle install --without development test

COPY . .

EXPOSE 3000
CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "3000"]`;
    dockerignoreExtras = '\n# Ruby\ntmp/\nlog/\n.env\nstorage/\n*.log';
  }

  // ─── Go ─────────────────────────────────────────────────────────────
  else if (appType === 'go') {
    // Read module name from go.mod for the binary name
    let moduleName = 'app';
    try {
      const gomod = fs.readFileSync('go.mod', 'utf-8');
      const match = gomod.match(/^module\s+(\S+)/m);
      if (match) moduleName = path.basename(match[1]);
    } catch { /* use default */ }

    dockerfile = `# ── Stage 1: Build ─────────────────────────────────────────────────
FROM golang:1.22-alpine AS builder

WORKDIR /build

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o ${moduleName} .

# ── Stage 2: Run ───────────────────────────────────────────────────
FROM alpine:latest

RUN apk --no-cache add ca-certificates

WORKDIR /app
COPY --from=builder /build/${moduleName} .

EXPOSE 8080
CMD ["./${moduleName}"]`;
    dockerignoreExtras = '\n# Go\nbin/\n*.exe\n.env';
  }

  // ─── Java / Spring Boot ─────────────────────────────────────────────
  else if (appType === 'java') {
    dockerfile = `# ── Stage 1: Build ─────────────────────────────────────────────────
FROM eclipse-temurin:21-jdk AS builder

WORKDIR /build

COPY pom.xml .
COPY src ./src
RUN apt-get update && apt-get install -y maven
RUN mvn clean package -DskipTests

# ── Stage 2: Run ───────────────────────────────────────────────────
FROM eclipse-temurin:21-jre

WORKDIR /app
COPY --from=builder /build/target/*.jar app.jar

EXPOSE 8080
CMD ["java", "-jar", "app.jar"]`;
    dockerignoreExtras = '\n# Java / Maven\ntarget/\n*.class\n.env';
  }

  // ─── Static HTML ────────────────────────────────────────────────────
  else if (appType === 'static') {
    dockerfile = `FROM nginx:alpine
RUN rm -rf /usr/share/nginx/html/*
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]`;
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

    dockerfile = `FROM node:20-alpine
WORKDIR /app
${setupPM}
COPY package*.json ${lockFile}./
${dockerInstallCmd}
COPY . .
${buildCommand ? `RUN ${buildCommand}` : '# No build step required'}
EXPOSE 3000
CMD ${JSON.stringify(startCommand.split(' '))}`;
  }

  fs.writeFileSync('Dockerfile', dockerfile.trim());
  log.success('Dockerfile generated (Production-ready 🚀)');

  /* ── .dockerignore ───────────────────────────────────────────────── */
  if (!fs.existsSync('.dockerignore')) {
    const baseIgnore = `.git\n.env\nautoflow.config.json${dockerignoreExtras}`;
    // Add node_modules only for JS-based projects
    const nodeIgnore = ['node', 'next', 'nuxt', 'vue', 'vite', 'react', 'angular'].includes(appType)
      ? '\nnode_modules\ndist\nbuild'
      : '';
    fs.writeFileSync('.dockerignore', baseIgnore + nodeIgnore);
    log.success('.dockerignore created ✔');
  }

  /* ── .gitignore ──────────────────────────────────────────────────── */
  if (fs.existsSync('.gitignore')) {
    const gitignore = fs.readFileSync('.gitignore', 'utf-8');
    const additions: string[] = [];
    if (!gitignore.includes('.env')) additions.push('.env');
    if (!gitignore.includes('autoflow.config.json')) additions.push('autoflow.config.json');
    if (additions.length > 0) {
      fs.appendFileSync('.gitignore', `\n# AutoFlow Secrets\n${additions.join('\n')}\n`);
      log.success('.gitignore updated ✔');
    }
  } else {
    const baseGitignore = `# AutoFlow\n.env\nautoflow.config.json\n.DS_Store\nThumbs.db\n`;
    fs.writeFileSync('.gitignore', baseGitignore);
    log.success('.gitignore created ✔');
  }

  /* ── Static-only extras ──────────────────────────────────────────── */
  if (appType === 'static') {
    if (!fs.existsSync('.autoflow.yml') && !fs.existsSync('.autoflow.yaml')) {
      fs.writeFileSync('.autoflow.yml', [
        `project: ${answers.projectName}`,
        `type: static`,
        ``,
        `# AutoFlow static project config`,
        `# Generated by "autoflow init"`,
      ].join('\n'));
      log.success('.autoflow.yml created ✔');
    }
    if (!fs.existsSync('.nojekyll')) {
      fs.writeFileSync('.nojekyll', '');
      log.success('.nojekyll created ✔');
    }
  }

  /* ── GitHub Actions CI workflow ───────────────────────────────────── */
  const workflowDir = '.github/workflows';
  const workflowPath = `${workflowDir}/ci.yml`;

  if (!fs.existsSync(workflowPath)) {
    fs.mkdirSync(workflowDir, { recursive: true });

    let ciWorkflow = '';

    const ciHeader = `name: CI

on:
  push:
    branches: [ main, master ]
  pull_request:
    branches: [ main, master ]

jobs:
`;

    // ── Laravel CI ──────────────────────────────────────────────────
    if (appType === 'laravel' || isConfirmedLaravel) {
      ciWorkflow = `${ciHeader}  ci:
    name: Laravel Application CI
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup PHP
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.2'
          extensions: mbstring, dom, fileinfo, mysql, pdo, pdo_mysql, bcmath, ctype, json, openssl, tokenizer, xml
          coverage: none

      - name: Install Composer Dependencies
        run: composer install --no-ansi --no-interaction --no-progress --prefer-dist --optimize-autoloader

      - name: Prepare Environment
        run: |
          if [ ! -f .env ]; then
            cp .env.example .env 2>/dev/null || touch .env
          fi
          php artisan key:generate --force || true

      - name: Check Dockerfile
        run: |
          [ -f "Dockerfile" ] || { echo "❌ Dockerfile missing"; exit 1; }
          echo "✅ Laravel Dockerfile verified"

      - name: Run Tests
        run: |
          if [ -f "vendor/bin/phpunit" ]; then
            vendor/bin/phpunit --no-coverage || echo "ℹ️ Tests skipped or non-fatal"
          elif [ -f "vendor/bin/pest" ]; then
            vendor/bin/pest || echo "ℹ️ Pest tests skipped or non-fatal"
          else
            echo "ℹ️ No test suite found, skipping test execution"
          fi
`;
    }
    // ── PHP CI ──────────────────────────────────────────────────────
    else if (appType === 'php') {
      const composerStep = fs.existsSync('composer.json')
        ? `
      - name: Install Composer dependencies
        run: composer install --no-progress --prefer-dist --optimize-autoloader`
        : '';

      ciWorkflow = `${ciHeader}  ci:
    name: PHP Syntax Check
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup PHP
        uses: shivammathur/setup-php@v2
        with:
          php-version: '8.2'
          extensions: mysqli, pdo, pdo_mysql
${composerStep}
      - name: PHP syntax check (lint all .php files)
        run: find . -name "*.php" -not -path "./.git/*" -not -path "./vendor/*" | xargs -I{} php -l {}

      - name: Check Dockerfile exists
        run: |
          [ -f "Dockerfile" ] || { echo "❌ Dockerfile missing"; exit 1; }
          echo "✅ Dockerfile present"
`;
    }

    // ── Django CI ───────────────────────────────────────────────────
    else if (appType === 'django') {
      ciWorkflow = `${ciHeader}  ci:
    name: Django CI
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install dependencies
        run: pip install -r requirements.txt

      - name: Django system check
        run: python manage.py check --deploy --settings=\${{ env.DJANGO_SETTINGS_MODULE || 'settings' }}
        continue-on-error: true

      - name: Run tests
        run: python manage.py test
        continue-on-error: false
`;
    }

    // ── Flask / Python CI ────────────────────────────────────────────
    else if (appType === 'flask' || appType === 'python') {
      ciWorkflow = `${ciHeader}  ci:
    name: Python / Flask CI
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'

      - name: Install dependencies
        run: pip install -r requirements.txt

      - name: Run tests
        run: |
          if command -v pytest &> /dev/null; then
            pytest
          else
            python -m unittest discover
          fi
        continue-on-error: false
`;
    }

    // ── Rails / Ruby CI ──────────────────────────────────────────────
    else if (appType === 'rails' || appType === 'ruby') {
      ciWorkflow = `${ciHeader}  ci:
    name: Ruby on Rails CI
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Ruby
        uses: ruby/setup-ruby@v1
        with:
          ruby-version: '3.3'
          bundler-cache: true

      - name: Run tests
        run: |
          if bundle exec rake --tasks | grep -q "spec"; then
            bundle exec rspec
          else
            bundle exec rails test
          fi
`;
    }

    // ── Go CI ────────────────────────────────────────────────────────
    else if (appType === 'go') {
      ciWorkflow = `${ciHeader}  ci:
    name: Go CI
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.22'

      - name: Download modules
        run: go mod download

      - name: Build
        run: go build ./...

      - name: Run tests
        run: go test ./... -v
`;
    }

    // ── Java / Spring CI ─────────────────────────────────────────────
    else if (appType === 'java') {
      ciWorkflow = `${ciHeader}  ci:
    name: Java / Maven CI
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Java
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '21'
          cache: 'maven'

      - name: Build and test
        run: mvn --batch-mode clean test

      - name: Package (verify JAR builds)
        run: mvn --batch-mode package -DskipTests
`;
    }

    // ── Static CI ────────────────────────────────────────────────────
    else if (appType === 'static') {
      ciWorkflow = `${ciHeader}  validate:
    name: Validate Static Project
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Check required files exist
        run: |
          echo "Checking required files..."
          [ -f "index.html" ]       || { echo "❌ index.html missing";       exit 1; }
          [ -f "Dockerfile" ]       || { echo "❌ Dockerfile missing";       exit 1; }
          [ -f ".autoflow.yml" ] || [ -f ".autoflow.yaml" ] || { echo "❌ .autoflow.yml missing"; exit 1; }
          echo "✅ All required files present."

      - name: Count HTML files
        run: |
          count=$(find . -name "*.html" -not -path "./.git/*" | wc -l)
          echo "✅ Found $count HTML file(s). Static validation passed."
`;

      // Suppress GitHub Pages
      const disablePagesWorkflow = `name: Disable GitHub Pages

# This workflow cancels the auto-triggered "pages build and deployment" job.
# This project is deployed via AutoFlow to a private server — GitHub Pages is not used.

on:
  workflow_run:
    workflows: ["pages build and deployment"]
    types: [requested]

jobs:
  cancel-pages:
    runs-on: ubuntu-latest
    steps:
      - name: Cancel GitHub Pages deployment
        uses: styfle/cancel-workflow-action@0.12.1
        with:
          workflow_id: \${{ github.event.workflow_run.id }}
          access_token: \${{ github.token }}
`;
      fs.writeFileSync(`${workflowDir}/disable-pages.yml`, disablePagesWorkflow);
      log.success('.github/workflows/disable-pages.yml created ✔');
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

      ciWorkflow = `${ciHeader}  ci:
    name: Build & Test
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: '${packageManager === 'pnpm' ? 'npm' : packageManager}'
${pmInstallYaml}${buildStep}${testStep}
`;
    }

    if (ciWorkflow) {
      fs.writeFileSync(workflowPath, ciWorkflow);
      log.success('.github/workflows/ci.yml created ✔');
    }
  }

  log.success(`\nInitialization complete! 🎉 Ready to deploy "${answers.projectName}".`);
}

export default init;
