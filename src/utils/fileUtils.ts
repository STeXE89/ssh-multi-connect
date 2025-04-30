import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Directory Operations
export function ensureDirectoryExists(dirPath: string, mode: number) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { mode });
    }
}

// File Existence and Permissions
export function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath);
}

export function ensureFileExists(filePath: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filePath)) {
            try {
                fs.writeFileSync(filePath, '', { mode });
                resolve();
            } catch (error) {
                reject(error);
            }
        } else {
            resolve();
        }
    });
}

export function chmodSync(filePath: string, mode: fs.Mode): void {
    fs.chmodSync(filePath, mode);
}

// Synchronous File Operations
export function readFile(filePath: string): string {
    try {
        return fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
        console.error(`Error reading file at ${filePath}:`, error);
        throw new Error(`Failed to read file: ${path.basename(filePath)}`);
    }
}

export function writeFile(filePath: string, content: string, mode: number) {
    fs.writeFileSync(filePath, content, { mode });
}

export function appendToFile(filePath: string, content: string) {
    fs.appendFileSync(filePath, content);
}

// Asynchronous File Operations
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
        fs.writeFile(filePath, data, { mode }, (err) => {
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
        fs.appendFile(filePath, data, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

// File Deletion
export function deleteFile(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        fs.unlink(filePath, (err) => {
            if (err) {
                console.error(`Failed to delete file: ${filePath}`, err);
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

// Temporary File Creation
export function createTempFile(prefix: string, suffix: string): string {
    const tempDir = path.join(os.tmpdir(), prefix);
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
    }
    return path.join(tempDir, `${prefix}-${Date.now()}${suffix}`);
}

// File Watching
export function watchFile(filePath: string, listener: (eventType: string, filename: string) => void): fs.FSWatcher {
    return fs.watch(filePath, (eventType, filename) => {
        if (filename) {
            listener(eventType, filename);
        }
    });
}