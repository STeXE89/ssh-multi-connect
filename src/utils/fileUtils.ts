import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomBytes } from 'crypto';

export function ensureDirectoryExists(dirPath: string, mode: number) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { mode });
    }
}

export function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath);
}

export function ensureFileExists(filePath: string, mode: number): void {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '', { mode });
    }
}

export function chmodSync(filePath: string, mode: fs.Mode): void {
    fs.chmodSync(filePath, mode);
}

export function readFile(filePath: string): string {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch {
        throw new Error(`Failed to read file: ${path.basename(filePath)}`);
    }
}

export function writeFile(filePath: string, content: string, mode: number) {
    fs.writeFileSync(filePath, content, { mode });
}

export function appendToFile(filePath: string, content: string) {
    fs.appendFileSync(filePath, content);
}

export function readFileAsync(filePath: string, encoding: BufferEncoding = 'utf-8'): Promise<string> {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, encoding, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

export function writeFileAsync(filePath: string, data: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.writeFile(filePath, data, { mode }, err => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

export function appendFileAsync(filePath: string, data: string): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.appendFile(filePath, data, err => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

export function deleteFile(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.unlink(filePath, err => (err ? reject(err) : resolve()));
    });
}

/**
 * Returns a process-private directory for downloaded remote files.
 *
 * The shared system temp directory is world-readable on a multi-user host.
 * This one is created 0700 and reused for the lifetime of the extension.
 */
let privateTempDir: string | undefined;

export function getPrivateTempDir(): string {
    if (!privateTempDir || !fs.existsSync(privateTempDir)) {
        privateTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-multi-connect-'));
        fs.chmodSync(privateTempDir, 0o700);
    }
    return privateTempDir;
}

/** Removes the private temp directory and everything left inside it. */
export function removePrivateTempDir(): void {
    if (privateTempDir && fs.existsSync(privateTempDir)) {
        fs.rmSync(privateTempDir, { recursive: true, force: true });
    }
    privateTempDir = undefined;
}

/** Restricts a file to the current user. */
export function restrictToOwner(filePath: string): void {
    if (fs.existsSync(filePath)) {
        fs.chmodSync(filePath, 0o600);
    }
}

export function createTempFile(prefix: string, suffix: string): string {
    const tempDir = path.join(os.tmpdir(), prefix);
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { mode: 0o700, recursive: true });
    }
    const unique = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    return path.join(tempDir, `${prefix}-${unique}${suffix}`);
}

export function watchFile(filePath: string, listener: (eventType: string, filename: string) => void): fs.FSWatcher {
    return fs.watch(filePath, (eventType, filename) => {
        listener(eventType, filename ?? path.basename(filePath));
    });
}
