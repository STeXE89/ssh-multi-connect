/**
 * Works out everything a drop will transfer, before any of it is sent.
 *
 * Walking the local tree is separated from the SFTP calls so the awkward part
 * -- recursion, ordering, and what to do about links -- can be tested against
 * a real directory without a server.
 */

import * as fs from 'fs';
import * as path from 'path';
import { uploadPath } from './dropTargets';

/** One thing to create or send. */
export interface UploadStep {
    kind: 'directory' | 'file';
    localPath: string;
    remotePath: string;
    /** Bytes, for files; zero for directories. */
    size: number;
}

/** What a drop amounts to. */
export interface UploadPlan {
    /** Parents always come before their contents. */
    steps: UploadStep[];
    /** Names that were left out, and why they cannot be sent. */
    skipped: { name: string; reason: string }[];
}

/**
 * Lists what uploading these paths into a remote folder would do.
 *
 * Symbolic links are skipped rather than followed: a link pointing back up its
 * own tree would never finish. Sockets, devices and the like are skipped too,
 * since there is nothing meaningful to copy.
 *
 * @param localPaths The files and folders dragged in.
 * @param destination The remote folder they land in.
 * @returns The transfer, in order.
 */
export async function planUpload(localPaths: string[], destination: string): Promise<UploadPlan> {
    const plan: UploadPlan = { steps: [], skipped: [] };

    for (const localPath of localPaths) {
        await addEntry(localPath, uploadPath(destination, localPath), plan);
    }

    return plan;
}

/**
 * Adds one entry, and everything under it, to a plan.
 *
 * @param localPath The local file or folder.
 * @param remotePath Where it lands.
 * @param plan The plan being built.
 */
async function addEntry(localPath: string, remotePath: string, plan: UploadPlan): Promise<void> {
    let stats: fs.Stats;
    try {
        stats = await fs.promises.lstat(localPath);
    } catch (error) {
        plan.skipped.push({ name: path.basename(localPath), reason: (error as Error).message });
        return;
    }

    if (stats.isSymbolicLink()) {
        plan.skipped.push({ name: path.basename(localPath), reason: 'symbolic link' });
        return;
    }

    if (stats.isDirectory()) {
        plan.steps.push({ kind: 'directory', localPath, remotePath, size: 0 });

        const entries = (await fs.promises.readdir(localPath)).sort();
        for (const entry of entries) {
            await addEntry(path.join(localPath, entry), `${remotePath}/${entry}`, plan);
        }
        return;
    }

    if (!stats.isFile()) {
        plan.skipped.push({ name: path.basename(localPath), reason: 'not a regular file' });
        return;
    }

    plan.steps.push({ kind: 'file', localPath, remotePath, size: stats.size });
}

/**
 * Describes what was left out of an upload.
 *
 * @param plan The plan that was carried out.
 * @returns A sentence, or undefined when nothing was skipped.
 */
export function describeSkipped(plan: UploadPlan): string | undefined {
    if (plan.skipped.length === 0) {
        return undefined;
    }

    return plan.skipped.map(entry => `${entry.name} (${entry.reason})`).join(', ');
}
