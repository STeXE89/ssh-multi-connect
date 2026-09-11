import * as vscode from 'vscode';

/** URI schemes used only to hang decorations off tree items. */
export const CONNECTION_SCHEME = 'ssh-connection';
export const FOLDER_SCHEME = 'ssh-folder';

/**
 * Builds the synthetic URI identifying a connection to the decorator.
 *
 * @param connectionId The connection's id.
 * @returns A URI in the connection scheme.
 */
export function connectionResourceUri(connectionId: string): vscode.Uri {
    return vscode.Uri.from({ scheme: CONNECTION_SCHEME, path: `/${connectionId}` });
}

/**
 * Builds the synthetic URI identifying a folder to the decorator.
 *
 * @param folderPath The folder's full path.
 * @returns A URI in the folder scheme.
 */
export function folderResourceUri(folderPath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: FOLDER_SCHEME, path: `/${folderPath}` });
}

/** Recovers the id or path a decoration URI was built from. */
function identifierOf(uri: vscode.Uri): string {
    return uri.path.replace(/^\//, '');
}

/**
 * Decorates the SSH Connections tree.
 *
 * Connected hosts get a colour, folders get a count badge. Tree labels and
 * badges are painted through file decorations, the same mechanism Git uses.
 * Scoped to the two synthetic schemes so the remote file tree, whose items
 * carry real `ssh://` URIs, is untouched.
 */
export class SSHTreeDecorationProvider implements vscode.FileDecorationProvider {
    private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> = this.changeEmitter.event;

    /**
     * @param isConnected Whether a connection id currently has a live client.
     * @param connectionsInFolder How many connections a folder holds.
     */
    constructor(
        private readonly isConnected: (connectionId: string) => boolean,
        private readonly connectionsInFolder: (folderPath: string) => number
    ) {}

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme === CONNECTION_SCHEME) {
            return this.isConnected(identifierOf(uri))
                ? { color: new vscode.ThemeColor('terminal.ansiGreen'), tooltip: 'Connected' }
                : undefined;
        }

        if (uri.scheme === FOLDER_SCHEME) {
            const count = this.connectionsInFolder(identifierOf(uri));
            if (count === 0) {
                return undefined;
            }

            return {
                // A badge holds at most two characters.
                badge: count > 99 ? '99' : String(count),
                tooltip: `${count} connection${count === 1 ? '' : 's'}`,
            };
        }

        return undefined;
    }

    /** Asks VS Code to re-query every decoration. */
    refresh(): void {
        this.changeEmitter.fire(undefined);
    }

    dispose(): void {
        this.changeEmitter.dispose();
    }
}
