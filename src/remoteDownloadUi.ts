/**
 * Saving a remote file or folder onto this machine.
 *
 * The opposite of dropping files on the tree. Opening a file in the editor
 * already copies it to a temporary place, but that copy is thrown away; this
 * puts one where the user asked for it.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { ExtendedSSHConnection } from './sshConnection';
import * as sftpUtils from './utils/sftpUtils';
import { RemoteEntry, planRemoteCopy, posixBasename, posixJoin } from './utils/remoteCopy';

/**
 * Asks where to save a remote entry, then downloads it.
 *
 * A file offers a save dialog with its own name filled in; a folder asks for
 * the directory to put it in, since the folder itself is recreated there.
 *
 * @param connection The host the entries live on.
 * @param entries The entries to download.
 */
export async function downloadRemote(
    connection: ExtendedSSHConnection,
    entries: { path: string; isDirectory: boolean }[]
): Promise<void> {
    if (!connection.client) {
        vscode.window.showErrorMessage(`Connect to ${connection.host} before downloading.`);
        return;
    }

    if (entries.length === 0) {
        return;
    }

    // One file can be renamed on the way out; anything else keeps its name and
    // only needs somewhere to go.
    const single = entries.length === 1 && !entries[0].isDirectory;
    const name = posixBasename(entries[0].path);
    const target = single ? await askForFile(name) : await askForFolder(entries.length === 1 ? name : 'the selection');
    if (!target) {
        return;
    }

    for (const entry of entries) {
        await downloadOne(connection, entry.path, entry.isDirectory, target, single);
    }
}

/**
 * Downloads one entry into an already-chosen place.
 *
 * @param connection The host it lives on.
 * @param remotePath The entry.
 * @param isDirectory Whether it is a folder.
 * @param target The local file or folder chosen.
 * @param exact Whether the target names the file itself rather than a folder.
 */
async function downloadOne(
    connection: ExtendedSSHConnection,
    remotePath: string,
    isDirectory: boolean,
    target: string,
    exact: boolean
): Promise<void> {
    const name = posixBasename(remotePath);

    try {
        const sftp = await sftpUtils.getSFTPClient(connection.client!);
        const stat = await sftpUtils.getRemoteStat(sftp, remotePath);

        const root: RemoteEntry = {
            path: remotePath,
            isDirectory,
            isSymbolicLink: false,
            size: stat.size ?? 0,
            mode: stat.mode,
        };

        // The planner works in POSIX paths on both sides; the local paths are
        // built from its results rather than by it.
        const plan = await planRemoteCopy(root, '/', remote => listRemote(sftp, remote));
        const files = plan.steps.filter(step => step.kind === 'file');

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Downloading ${name} from ${connection.host}`,
                cancellable: true,
            },
            async (progress, token) => {
                let done = 0;
                for (const step of plan.steps) {
                    if (token.isCancellationRequested) {
                        return;
                    }

                    const local = localPathFor(step.to, target, !exact);

                    if (step.kind === 'directory') {
                        await fs.promises.mkdir(local, { recursive: true });
                        continue;
                    }

                    await fs.promises.mkdir(path.dirname(local), { recursive: true });
                    progress.report({ message: `${++done}/${files.length} ${step.from}` });
                    await sftpUtils.downloadRemoteFile(sftp, step.from, local);
                }
            }
        );

        report(files.length, target, plan.skipped);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Download of ${name} failed: ${error.message}`);
    }
}

/**
 * Turns a planned destination into a local path.
 *
 * The plan was made against a POSIX root, so its `to` paths are
 * `/<name>/...`; everything after the entry's own name hangs off whatever the
 * user chose.
 *
 * @param planned The path the plan produced.
 * @param target The local file or folder the user chose.
 * @param intoFolder Whether the target is a folder to build inside, rather
 * than the exact file to write.
 * @returns The local path to write.
 */
export function localPathFor(planned: string, target: string, intoFolder: boolean): string {
    const segments = planned.split('/').filter(Boolean);

    // A file saved under a name of its own goes exactly there.
    if (!intoFolder) {
        return target;
    }

    // Anything else is recreated inside the chosen directory, so its own name
    // is kept along with everything under it.
    return path.join(target, ...segments);
}

/** Asks for the file to save a single download as. */
async function askForFile(name: string): Promise<string | undefined> {
    const chosen = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(defaultDirectory(), name)),
        saveLabel: 'Download',
        title: `Save ${name}`,
    });

    return chosen?.fsPath;
}

/** Asks for the directory a downloaded folder is recreated in. */
async function askForFolder(name: string): Promise<string | undefined> {
    const chosen = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        defaultUri: vscode.Uri.file(defaultDirectory()),
        openLabel: 'Download here',
        title: `Save ${name} into`,
    });

    return chosen?.[0]?.fsPath;
}

/** Where the dialogs start: the open folder, or the home directory. */
function defaultDirectory(): string {
    const [folder] = vscode.workspace.workspaceFolders ?? [];
    return folder?.uri.fsPath ?? require('os').homedir();
}

/** Says what landed, and what was left out. */
function report(files: number, target: string, skipped: { name: string; reason: string }[]): void {
    const where = `Downloaded ${files} file(s) to ${target}`;
    const left = skipped.map(entry => `${entry.name} (${entry.reason})`).join(', ');

    if (left) {
        vscode.window.showWarningMessage(`${where}, skipping ${left}.`);
    } else {
        vscode.window.showInformationMessage(`${where}.`);
    }
}

/**
 * Lists a remote directory in the shape the planner expects.
 *
 * @param sftp The host's SFTP session.
 * @param directory The directory to list.
 * @returns Its entries.
 */
async function listRemote(sftp: any, directory: string): Promise<RemoteEntry[]> {
    const entries = await sftpUtils.readRemoteDirectory(sftp, directory);

    return entries.map((entry: any) => ({
        path: posixJoin(directory, entry.filename),
        isDirectory: !!entry.attrs?.isDirectory?.(),
        isSymbolicLink: !!entry.attrs?.isSymbolicLink?.(),
        size: entry.attrs?.size ?? 0,
        mode: entry.attrs?.mode,
    }));
}
