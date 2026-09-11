import { Client } from 'ssh2';
import { quote } from './shell';

export async function getSFTPClient(client: Client): Promise<any> {
    return new Promise((resolve, reject) => {
        client.sftp((err, sftp) => {
            if (err) {
                reject(err);
            } else {
                resolve(sftp);
            }
        });
    });
}

export function readRemoteDirectory(sftp: any, remotePath: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
        sftp.readdir(remotePath, (err: any, list: any[]) => {
            if (err) {
                reject(err);
            } else {
                resolve(list);
            }
        });
    });
}

export function getRemoteStat(sftp: any, remotePath: string): Promise<any> {
    return new Promise((resolve, reject) => {
        sftp.stat(remotePath, (err: any, stats: any) => {
            if (err) {
                reject(err);
            } else {
                resolve(stats);
            }
        });
    });
}

/** Reports bytes transferred so far out of the total, when the total is known. */
export type TransferProgress = (transferred: number, total: number) => void;

export function downloadRemoteFile(
    sftp: any,
    remotePath: string,
    localPath: string,
    onProgress?: TransferProgress
): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.fastGet(
            remotePath,
            localPath,
            {
                // Concurrency and chunk size matter on high-latency links;
                // the ssh2 defaults are conservative for large files.
                concurrency: 16,
                chunkSize: 32768,
                step: (transferred: number, _chunk: number, total: number) => onProgress?.(transferred, total),
            },
            (err: any) => (err ? reject(err) : resolve())
        );
    });
}

export function uploadRemoteFile(
    sftp: any,
    localPath: string,
    remotePath: string,
    onProgress?: TransferProgress
): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.fastPut(
            localPath,
            remotePath,
            {
                concurrency: 16,
                chunkSize: 32768,
                step: (transferred: number, _chunk: number, total: number) => onProgress?.(transferred, total),
            },
            (err: any) => (err ? reject(err) : resolve())
        );
    });
}

export function createRemoteFile(sftp: any, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.open(remotePath, 'w', (err: any, handle: any) => {
            if (err) {
                reject(err);
            } else {
                sftp.close(handle, (closeErr: any) => {
                    if (closeErr) {
                        reject(closeErr);
                    } else {
                        resolve();
                    }
                });
            }
        });
    });
}

export function createRemoteDirectory(sftp: any, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.mkdir(remotePath, (err: any) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

export async function changeRemotePermissions(sftp: any, remotePath: string, mode: number): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.chmod(remotePath, mode, (err: any) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

export async function getAvailableUsers(sftp: any): Promise<{ name: string; id: string }[]> {
    return new Promise((resolve, reject) => {
        const remotePath = '/etc/passwd';
        let data = '';
        const stream = sftp.createReadStream(remotePath);

        stream.on('data', (chunk: string) => {
            data += chunk;
        });

        stream.on('end', () => {
            const users = data
                .split('\n')
                .filter(line => line && !line.startsWith('#')) // Exclude comments
                .map(line => {
                    const parts = line.split(':');
                    return { name: parts[0], id: parts[2] }; // Extract username and UID
                });
            resolve(users);
        });

        stream.on('error', (err: any) => {
            reject(err);
        });
    });
}

export async function getAvailableGroups(sftp: any): Promise<{ name: string; id: string }[]> {
    return new Promise((resolve, reject) => {
        const remotePath = '/etc/group';
        let data = '';
        const stream = sftp.createReadStream(remotePath);

        stream.on('data', (chunk: string) => {
            data += chunk;
        });

        stream.on('end', () => {
            const groups = data
                .split('\n')
                .filter(line => line && !line.startsWith('#')) // Exclude comments
                .map(line => {
                    const parts = line.split(':');
                    return { name: parts[0], id: parts[2] }; // Extract group name and GID
                });
            resolve(groups);
        });

        stream.on('error', (err: any) => {
            reject(err);
        });
    });
}

/** A uid/gid, or a POSIX user or group name. */
const OWNER_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]*\$?$/;

export async function changeRemoteOwnership(
    client: Client,
    remotePath: string,
    user: string,
    group: string
): Promise<void> {
    // user and group arrive from the permissions webview, and remotePath is a
    // remote filename: none of them may reach the remote shell unquoted.
    if (!OWNER_PATTERN.test(user) || !OWNER_PATTERN.test(group)) {
        throw new Error(`Invalid user or group: "${user}:${group}"`);
    }

    return new Promise((resolve, reject) => {
        const command = `chown ${quote(`${user}:${group}`)} ${quote(remotePath)}`;
        client.exec(command, (err, stream) => {
            if (err) {
                reject(err);
                return;
            }

            let stderr = '';
            stream.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            stream.on('close', (code: number) => {
                if (code === 0) {
                    resolve();
                } else {
                    // The remote message is what the user needs to see, so it
                    // travels with the rejection rather than to the console.
                    reject(new Error(stderr.trim() || `chown exited with code ${code}.`));
                }
            });
        });
    });
}

export function unlinkRemoteFile(sftp: any, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.unlink(remotePath, (err: any) => (err ? reject(err) : resolve()));
    });
}

export function removeRemoteDirectory(sftp: any, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.rmdir(remotePath, (err: any) => (err ? reject(err) : resolve()));
    });
}

export function renameRemote(sftp: any, fromPath: string, toPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.rename(fromPath, toPath, (err: any) => (err ? reject(err) : resolve()));
    });
}

/**
 * Deletes a remote entry, emptying a directory first.
 *
 * Done over SFTP rather than by running `rm -rf`, so no remote shell is
 * involved and a hostile filename cannot become part of a command. Symbolic
 * links are unlinked rather than followed, so deleting a link never touches
 * whatever it points at.
 *
 * @param sftp The SFTP session.
 * @param remotePath The entry to delete.
 * @param isDirectory Whether the entry is a directory.
 */
export async function deleteRemoteEntry(sftp: any, remotePath: string, isDirectory: boolean): Promise<void> {
    if (!isDirectory) {
        await unlinkRemoteFile(sftp, remotePath);
        return;
    }

    for (const entry of await readRemoteDirectory(sftp, remotePath)) {
        const childPath = `${remotePath.replace(/\/+$/, '')}/${entry.filename}`;

        if (entry.attrs.isSymbolicLink?.()) {
            await unlinkRemoteFile(sftp, childPath);
        } else {
            await deleteRemoteEntry(sftp, childPath, entry.attrs.isDirectory());
        }
    }

    await removeRemoteDirectory(sftp, remotePath);
}

/**
 * Counts the entries beneath a directory, for a delete confirmation.
 *
 * @param sftp The SFTP session.
 * @param remotePath The directory to measure.
 * @returns The number of entries, or 0 if it cannot be read.
 */
export async function countRemoteEntries(sftp: any, remotePath: string): Promise<number> {
    try {
        const entries = await readRemoteDirectory(sftp, remotePath);
        let total = entries.length;

        for (const entry of entries) {
            if (entry.attrs.isDirectory() && !entry.attrs.isSymbolicLink?.()) {
                total += await countRemoteEntries(sftp, `${remotePath.replace(/\/+$/, '')}/${entry.filename}`);
            }
        }

        return total;
    } catch {
        return 0;
    }
}
