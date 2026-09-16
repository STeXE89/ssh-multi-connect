/**
 * Uploading by picking local files, rather than by dragging them in.
 *
 * Dropping onto the tree already works, but it needs both windows on screen at
 * once and a file manager to drag from. This asks for the files instead.
 */

import * as vscode from 'vscode';
import { RemoteFileProvider } from './remoteFile';
import { dropDestination } from './utils/dropTargets';

/** What is being uploaded, which decides the dialog shown. */
type Choice = 'files' | 'folder';

/**
 * Asks which local files or folder to send, then uploads them.
 *
 * Files and folders are asked for separately: on Windows and Linux a single
 * dialog cannot offer both.
 *
 * @param connectionId The connection to upload over.
 * @param target The tree item the upload was started from, if any.
 */
export async function uploadToRemote(
    connectionId: string | undefined,
    target: { path: string; isDirectory: boolean } | undefined
): Promise<void> {
    const provider = connectionId ? RemoteFileProvider.getProviderByConnectionId(connectionId) : undefined;
    if (!provider) {
        vscode.window.showErrorMessage('Open a connection before uploading.');
        return;
    }

    // Started from the title bar there is no target, so the folder the tree is
    // rooted at is where the files land.
    const destination = dropDestination(target, provider.rootPath);

    const choice = await vscode.window.showQuickPick<vscode.QuickPickItem & { choice: Choice }>(
        [
            { label: '$(file) Files...', detail: 'One or more files', choice: 'files' },
            { label: '$(folder) Folder...', detail: 'A folder and everything in it', choice: 'folder' },
        ],
        { placeHolder: `Upload to ${destination}` }
    );

    if (!choice) {
        return;
    }

    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: choice.choice === 'files',
        canSelectFolders: choice.choice === 'folder',
        canSelectMany: choice.choice === 'files',
        openLabel: 'Upload',
        title: `Upload to ${destination}`,
        defaultUri: defaultDirectory(),
    });

    if (!picked || picked.length === 0) {
        return;
    }

    await provider.upload(
        destination,
        picked.map(uri => uri.fsPath)
    );
}

/** Where the dialog starts: the open folder, or wherever the system prefers. */
function defaultDirectory(): vscode.Uri | undefined {
    const [folder] = vscode.workspace.workspaceFolders ?? [];
    return folder?.uri;
}
