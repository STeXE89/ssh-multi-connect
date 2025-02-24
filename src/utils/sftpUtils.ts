import { Client } from 'ssh2';

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

export function downloadRemoteFile(sftp: any, remotePath: string, localPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.fastGet(remotePath, localPath, {}, (err: any) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

export function uploadRemoteFile(sftp: any, localPath: string, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, {}, (err: any) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}