import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import speakeasy from 'speakeasy';
import { EventEmitter } from 'events';

export const VAULT_PATH = path.join(os.homedir(), '.autoflow', 'vault.json');
const ALGORITHM = 'aes-256-gcm';
const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

export interface VaultConfig {
    passwordHash: string;
    totpSecret: string; // Stored encrypted
    salt: string;
    sshPassword?: string;
    projectTokens?: Record<string, string>;
}

// Data Integrity helper
export function handleCorruptedJson(filePath: string, error: any): never {
    console.error(`[Data Integrity] JSON parse failed for file: ${filePath}. Error: ${error.message}`);
    try {
        if (fs.existsSync(filePath)) {
            const backupPath = `${filePath}.corrupted.${Date.now()}`;
            fs.copyFileSync(filePath, backupPath);
            console.error(`[Data Integrity] Backup created at: ${backupPath}`);
        }
    } catch (backupErr: any) {
        console.error(`[Data Integrity] Failed to create backup: ${backupErr.message}`);
    }
    throw error;
}

// Standalone functions for I/O & crypto
export function loadVaultConfig(): VaultConfig | null {
    if (!fs.existsSync(VAULT_PATH)) return null;
    try {
        return JSON.parse(fs.readFileSync(VAULT_PATH, 'utf-8'));
    } catch (err: any) {
        handleCorruptedJson(VAULT_PATH, err);
    }
}

export function saveVaultConfig(config: VaultConfig): void {
    const dir = path.dirname(VAULT_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(VAULT_PATH, JSON.stringify(config), { mode: 0o600 });
}

export function hashPassword(password: string, salt: string): string {
    return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

export function verifyOTP(token: string, secret: string): boolean {
    return speakeasy.totp.verify({
        secret,
        encoding: 'base32',
        token,
        window: 1 // Allow 30s clock drift
    });
}

// AES-256-GCM encryption with NIST-standard 12-byte IV and unique per-secret salt
export function encryptWithPassword(text: string, password: string): string {
    const salt = crypto.randomBytes(16); // 16-byte random unique salt
    const key = crypto.scryptSync(password, salt, 32);
    const iv = crypto.randomBytes(12); // NIST-standard 12-byte IV
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decryptWithPassword(encryptedData: string, password: string): string {
    const parts = encryptedData.split(':');
    if (parts.length < 4) {
        throw new Error('Invalid encrypted data format');
    }
    const [saltHex, ivHex, authTagHex, encryptedText] = parts;
    const salt = Buffer.from(saltHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const key = crypto.scryptSync(password, salt, 32);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

export function deleteVault(): void {
    if (fs.existsSync(VAULT_PATH)) {
        fs.unlinkSync(VAULT_PATH);
    }
}

export class VaultEngine extends EventEmitter {
    private sessionPassword: string | null = null;
    private lastActivityTimestamp: number = 0;
    private idleTimer: NodeJS.Timeout | null = null;
    private failedAttempts: number = 0;
    private lockoutUntil: number = 0;

    constructor() {
        super();
        this.resetActivity();
    }

    public resetActivity() {
        this.lastActivityTimestamp = Date.now();
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
        }
        if (this.sessionPassword) {
            this.idleTimer = setTimeout(() => {
                this.lock();
            }, IDLE_TIMEOUT_MS);
        }
    }

    public lock() {
        this.sessionPassword = null;
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        console.log('[Vault] Vault session locked due to manual trigger or idle timeout.');
        this.emit('lock-state-change', true);
    }

    public isUnlocked(): boolean {
        if (this.sessionPassword && Date.now() - this.lastActivityTimestamp <= IDLE_TIMEOUT_MS) {
            return true;
        }
        // Machine-bound encrypted 15-min CLI session cache
        const sessionPath = path.join(os.homedir(), '.autoflow', 'session.lock');
        try {
            if (fs.existsSync(sessionPath)) {
                const session = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
                if (session.expiresAt && Date.now() < session.expiresAt && session.encrypted) {
                    const machineKey = `${os.hostname()}-${os.userInfo().username}-${os.arch()}`;
                    const recovered = decryptWithPassword(session.encrypted, machineKey);
                    if (recovered) {
                        this.sessionPassword = recovered;
                        this.resetActivity();
                        return true;
                    }
                }
            }
        } catch {}
        this.lock();
        return false;
    }

    public getSessionPassword(): string | null {
        if (!this.isUnlocked()) return null;
        return this.sessionPassword;
    }

    public unlock(password: string, otpToken: string): boolean {
        if (Date.now() < this.lockoutUntil) {
            const remaining = Math.ceil((this.lockoutUntil - Date.now()) / 1000);
            throw new Error(`Vault locked due to too many failed attempts. Try again in ${remaining} seconds.`);
        }

        const vault = loadVaultConfig();
        if (!vault) {
            throw new Error('Vault has not been set up yet. Run onboarding first.');
        }

        // Verify password
        const hashed = hashPassword(password, vault.salt);
        if (hashed !== vault.passwordHash) {
            this.handleFailedAttempt();
            return false;
        }

        // Decrypt TOTP Secret using password
        let decryptedSecret = '';
        try {
            decryptedSecret = decryptWithPassword(vault.totpSecret, password);
        } catch (err) {
            this.handleFailedAttempt();
            return false;
        }

        // Verify OTP
        const verified = verifyOTP(otpToken, decryptedSecret);

        if (verified) {
            this.failedAttempts = 0;
            this.sessionPassword = password;
            this.resetActivity();
            // Save encrypted 15-min CLI session cache
            try {
                const sessionPath = path.join(os.homedir(), '.autoflow', 'session.lock');
                const machineKey = `${os.hostname()}-${os.userInfo().username}-${os.arch()}`;
                const encrypted = encryptWithPassword(password, machineKey);
                fs.writeFileSync(sessionPath, JSON.stringify({ encrypted, expiresAt: Date.now() + IDLE_TIMEOUT_MS }), { mode: 0o600 });
            } catch {}
            this.emit('lock-state-change', false);
            return true;
        }

        this.handleFailedAttempt();
        return false;
    }

    private handleFailedAttempt() {
        this.failedAttempts++;
        if (this.failedAttempts >= 5) {
            this.lockoutUntil = Date.now() + 15 * 60 * 1000; // 15 mins
            this.failedAttempts = 0;
            throw new Error('Vault locked due to too many failed attempts. Try again in 15 minutes.');
        }
    }

    public setupVault(password: string, totpSecret: string): void {
        const salt = crypto.randomBytes(16).toString('hex');
        const passwordHash = hashPassword(password, salt);

        // Encrypt totpSecret using password
        const encryptedTotp = encryptWithPassword(totpSecret, password);

        const config: VaultConfig = {
            passwordHash,
            totpSecret: encryptedTotp,
            salt
        };

        saveVaultConfig(config);
        this.sessionPassword = password;
        this.resetActivity();
        this.emit('lock-state-change', false);
    }

    public encrypt(text: string): string {
        this.resetActivity();
        if (!this.sessionPassword) {
            throw new Error('Vault is locked. Unlock session first.');
        }
        return encryptWithPassword(text, this.sessionPassword);
    }

    public decrypt(encryptedData: string): string {
        this.resetActivity();
        if (!this.sessionPassword) {
            throw new Error('Vault is locked. Unlock session first.');
        }
        return decryptWithPassword(encryptedData, this.sessionPassword);
    }

    public deleteVault(): void {
        this.lock();
        deleteVault();
    }
}

export const vaultEngine = new VaultEngine();
