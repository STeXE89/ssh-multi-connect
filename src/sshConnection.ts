import * as vscode from 'vscode';
import { Client, utils } from 'ssh2';
import {
    MULTICOMMANDPANEL_HTML_PATH,
    MULTICOMMANDPANEL_CSS_PATH,
    MULTICOMMANDPANEL_JS_PATH,
    getExtensionUri,
} from './constants/globals';
import * as fileUtils from './utils/fileUtils';
import { SSHPseudoterminal } from './sshTerminal';
import { SSHTreeDecorationProvider, connectionResourceUri, folderResourceUri } from './connectionDecorations';
import { RemoteFilesView } from './remoteFilesView';
import { TerminalPathFollower } from './terminalFollow';
import { TunnelManager } from './tunnels';
import { SSHTunnelTreeItem, promptForTunnel } from './tunnelUi';
import { tunnelLabel, tunnelFlag } from './utils/tunnelModel';
import { FileDetailsViewProvider } from './fileDetailsView';
import {
    collectFolderPaths,
    normalizeFolderPath,
    isSelfNesting,
    movedFolderPath,
    reparentTag,
    countInFolder,
} from './utils/folders';
import { RemoteFileProvider, RemoteFileViewTitle, EmptyRemoteFileProvider } from './remoteFile';
import {
    SSH_DEFAULT_PORT,
    SSHConnection,
    insertOrUpdateConnection,
    getAllConnections,
    removeConnection,
    createIdentityFile,
    getIdentityFile,
    addKnownHost,
    removeKnownHost,
    isKnownHost,
    getHostKeyFromKeyscan,
} from './utils/sshUtils';

export interface ExtendedSSHConnection extends SSHConnection {
    id: string;
    client?: Client;
    usePrivateKey?: boolean;
    password?: string;
    privateKey?: Buffer;
    passphrase?: string;
    fingerprint?: string;
}

export async function addSSHConnection(sshViewProvider: SSHViewProvider) {
    try {
        const host = await vscode.window.showInputBox({ placeHolder: 'Host' });
        if (!host) {
            vscode.window.showErrorMessage('Host is required.');
            return;
        }

        const hostname = await vscode.window.showInputBox({ placeHolder: 'HostName' });
        if (!hostname) {
            vscode.window.showErrorMessage('HostName is required.');
            return;
        }

        const user = await vscode.window.showInputBox({ placeHolder: 'Username' });

        const port = await vscode.window.showInputBox({
            placeHolder: `Port (default ${SSH_DEFAULT_PORT})`,
            value: SSH_DEFAULT_PORT.toString(),
        });
        const usePrivateKey = await vscode.window.showQuickPick(['Yes', 'No'], {
            placeHolder: 'Use SSH Key?',
        });
        if (!usePrivateKey) {
            vscode.window.showErrorMessage('SSH Key usage selection is required.');
            return;
        }

        let identityFile: string | undefined;
        if (usePrivateKey === 'Yes') {
            identityFile = createIdentityFile(host);

            const document = await vscode.workspace.openTextDocument(identityFile);
            await vscode.window.showTextDocument(document);

            await vscode.window.showWarningMessage(
                'Paste your SSH private key into the opened file and save it, then click Done.',
                'Done'
            );

            await new Promise<void>(resolve => {
                const interval = setInterval(async () => {
                    if (!identityFile) {
                        throw new Error('Identity file path is undefined.');
                    }
                    const editorContent = await vscode.workspace.openTextDocument(identityFile);
                    if (!editorContent.isDirty) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 1000);
            });

            const privateKeyContent = fileUtils.readFile(identityFile);
            if (!privateKeyContent) {
                vscode.window.showErrorMessage('SSH Private Key is required.');
                return;
            }

            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }

        const existingConnection = sshViewProvider.connections.find(
            (conn: ExtendedSSHConnection) => conn.host === host && conn.user === user
        );
        if (existingConnection) {
            vscode.window.showInformationMessage(`Connection to ${host} as ${user} already exists.`);
            return;
        }

        const newConnection = {
            host,
            hostname,
            user,
            port: port ? parseInt(port) : SSH_DEFAULT_PORT,
            identityFile: usePrivateKey === 'Yes' ? identityFile : undefined,
        };

        insertOrUpdateConnection(newConnection);

        sshViewProvider.loadSSHConnections();

        sshViewProvider.connections.push({
            id: host,
            host,
            hostname,
            user,
            port: port ? parseInt(port) : SSH_DEFAULT_PORT,
            usePrivateKey: usePrivateKey === 'Yes',
            identityFile: usePrivateKey === 'Yes' ? identityFile : undefined,
        });

        const uniqueConnections = sshViewProvider.connections.filter(
            (conn, index, self) => index === self.findIndex(c => c.host === conn.host && c.user === conn.user)
        );

        sshViewProvider.connections = uniqueConnections;
        sshViewProvider.refresh();

        if (sshViewProvider.multiCommandPanel) {
            const connectedConnections = sshViewProvider.connections.filter(conn => conn.client);
            sshViewProvider.multiCommandPanel.updateConnections(connectedConnections);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Error adding SSH connection: ${error.message}`);
    }
}

/** Extracts a human-readable message from an unknown thrown value. */
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Orders connections for the tree: foldered entries first, then by host. */
const compareConnections = (a: ExtendedSSHConnection, b: ExtendedSSHConnection): number => {
    if (a.vFolderTag && b.vFolderTag) {
        return a.vFolderTag.localeCompare(b.vFolderTag);
    }
    if (a.vFolderTag) {
        return -1;
    }
    if (b.vFolderTag) {
        return 1;
    }

    const byHost = a.host.localeCompare(b.host);
    if (byHost !== 0) {
        return byHost;
    }
    if (a.user === undefined && b.user !== undefined) {
        return 1;
    }
    if (a.user !== undefined && b.user === undefined) {
        return -1;
    }
    return 0;
};

/** Anything that can appear in the SSH Connections tree. */
export type SSHTreeNode = SSHConnectionTreeItem | SSHFolderTreeItem | SSHTunnelTreeItem;

export class SSHViewProvider implements vscode.TreeDataProvider<SSHTreeNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<SSHConnectionTreeItem | undefined | void> =
        new vscode.EventEmitter<SSHConnectionTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<SSHConnectionTreeItem | undefined | void> =
        this._onDidChangeTreeData.event;

    public connections: ExtendedSSHConnection[] = [];
    private selectedConnection?: ExtendedSSHConnection;
    private terminals: Map<string, vscode.Terminal> = new Map();
    public multiCommandPanel?: MultiCommandPanel;
    private detailsView?: FileDetailsViewProvider;
    private decorationProvider?: SSHTreeDecorationProvider;
    private remoteFilesView?: RemoteFilesView;
    private pathFollower?: TerminalPathFollower;
    private tunnels?: TunnelManager;

    // activate() owns the tree view and the terminal-close listener.
    constructor(_context: vscode.ExtensionContext) {
        this.loadSSHConnections();
    }

    getTreeItem(element: SSHTreeNode): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SSHTreeNode): Thenable<SSHTreeNode[]> {
        if (!element) {
            // Root level: Group connections by top-level folder
            const folderMap = new Map<string, ExtendedSSHConnection[]>();
            const rootConnections: ExtendedSSHConnection[] = [];

            for (const connection of this.connections) {
                if (connection.vFolderTag) {
                    const topLevelFolder = connection.vFolderTag.split('/')[0]; // Extract the top-level folder
                    if (!folderMap.has(topLevelFolder)) {
                        folderMap.set(topLevelFolder, []);
                    }
                    folderMap.get(topLevelFolder)!.push(connection);
                } else {
                    rootConnections.push(connection); // Add connections without vFolderTag to root
                }
            }

            const tags = this.connections.map(conn => conn.vFolderTag);
            const folderItems = Array.from(folderMap.keys()).map(
                folderName => new SSHFolderTreeItem(folderName, countInFolder(tags, folderName))
            );
            const rootItems = rootConnections.map(conn => this.createConnectionItem(conn));

            // Combine folder items and root connections
            return Promise.resolve([...folderItems, ...rootItems]);
        } else if (element instanceof SSHConnectionTreeItem) {
            const hostLabel = element.connection.host;
            return Promise.resolve(
                (this.tunnels?.list(element.connection.id) ?? []).map(
                    entry => new SSHTunnelTreeItem(element.connection.id, entry, hostLabel)
                )
            );
        } else if (element instanceof SSHFolderTreeItem) {
            // Subfolder level: Filter connections and subfolders within the current folder
            const currentFolder = element.folderName;
            const subFolderMap = new Map<string, ExtendedSSHConnection[]>();
            const folderConnections: ExtendedSSHConnection[] = [];

            for (const connection of this.connections) {
                if (connection.vFolderTag && connection.vFolderTag.startsWith(`${currentFolder}/`)) {
                    const remainingPath = connection.vFolderTag.substring(currentFolder.length + 1); // Remove the current folder prefix
                    const nextFolder = remainingPath.split('/')[0]; // Extract the next folder or connection

                    // It's a subfolder
                    if (!subFolderMap.has(nextFolder)) {
                        subFolderMap.set(nextFolder, []);
                    }
                    subFolderMap.get(nextFolder)!.push(connection);
                } else if (connection.vFolderTag === currentFolder) {
                    // Directly add connections that belong to the current folder
                    folderConnections.push(connection);
                }
            }

            // Recursively create subfolder items
            const tags = this.connections.map(conn => conn.vFolderTag);
            const subFolderItems = Array.from(subFolderMap.keys()).map(subFolderName => {
                const subFolderPath = `${currentFolder}/${subFolderName}`;
                return new SSHFolderTreeItem(subFolderPath, countInFolder(tags, subFolderPath));
            });
            const connectionItems = folderConnections.map(conn => this.createConnectionItem(conn));

            // Combine subfolder items and connections
            return Promise.resolve([...subFolderItems, ...connectionItems]);
        }

        return Promise.resolve([]);
    }

    /**
     * Builds a connection item, expandable only when it carries tunnels.
     *
     * @param connection The connection to show.
     * @returns The tree item.
     */
    private createConnectionItem(connection: ExtendedSSHConnection): SSHConnectionTreeItem {
        const tunnelCount = this.tunnels?.list(connection.id).length ?? 0;
        return new SSHConnectionTreeItem(connection, !!connection.client, tunnelCount > 0);
    }

    getSelectedConnection(): ExtendedSSHConnection | undefined {
        return this.selectedConnection;
    }

    loadSSHConnections() {
        try {
            // Live sessions must survive a reload, including reloads triggered
            // by this extension's own writes to ssh_config.
            const live = new Map(this.connections.map(conn => [conn.host, conn]));

            this.connections = getAllConnections()
                .filter(conn => conn.host)
                .map(conn => {
                    const previous = live.get(conn.host);
                    return {
                        ...conn,
                        id: conn.host,
                        usePrivateKey: !!conn.identityFile,
                        client: previous?.client,
                        password: previous?.password,
                        passphrase: previous?.passphrase,
                        privateKey: previous?.privateKey,
                    };
                })
                .sort(compareConnections);

            this.syncMultiCommandPanel();
            this._onDidChangeTreeData.fire();
        } catch (error) {
            console.error('Error loading SSH connections:', error);
            vscode.window.showErrorMessage('Failed to load SSH connections.');
        }
    }

    /** Pushes the currently established connections to the command panel. */
    private syncMultiCommandPanel(): void {
        this.multiCommandPanel?.updateConnections(this.connections.filter(conn => conn.client));
    }

    public selectConnection(treeItem: SSHConnectionTreeItem) {
        const connection = treeItem.connection;
        const terminal = this.terminals.get(connection.id);

        if (connection.client) {
            this.selectedConnection = connection;

            const remoteFileProvider = RemoteFileProvider.createOrGetProvider(connection, '/');
            if (this.detailsView) {
                remoteFileProvider.setDetailsView(this.detailsView);
            }
            this.remoteFilesView?.setProvider(remoteFileProvider);

            const titleItem = new RemoteFileViewTitle(`Connected to ${connection.host}`);
            remoteFileProvider.setTitleItem(titleItem);
            remoteFileProvider.refresh();
        } else {
            this.selectedConnection = undefined;

            const emptyProvider = new EmptyRemoteFileProvider();
            const emptyTitleItem = new RemoteFileViewTitle('No Active Connection');
            emptyProvider.setTitleItem(emptyTitleItem);
            this.remoteFilesView?.setProvider(emptyProvider);
        }

        if (terminal) {
            terminal.show();
        }

        vscode.commands.executeCommand('setContext', 'sshConnectionActive', !!this.selectedConnection);

        if (this.selectedConnection) {
            this.loadRemoteFiles(this.selectedConnection, '/');
        }
    }

    public registerTerminal(connection: ExtendedSSHConnection, terminal: vscode.Terminal) {
        this.terminals.set(connection.id, terminal);
    }

    /**
     * Returns the terminal opened for a connection, if it is still open.
     *
     * @param connectionId The connection's id.
     * @returns The terminal, or undefined.
     */
    public getTerminal(connectionId: string): vscode.Terminal | undefined {
        return this.terminals.get(connectionId);
    }

    public removeConnection(treeItem: SSHConnectionTreeItem) {
        const connection = treeItem.connection;

        // A host block is keyed by its alias alone.
        if (!connection.host) {
            vscode.window.showErrorMessage('Host is required. Cannot remove connection.');
            return;
        }

        try {
            if (connection.client) {
                this.disconnect(treeItem);
            }

            removeConnection(connection.host);

            this.connections = this.connections.filter(conn => conn.host !== connection.host);
            RemoteFileProvider.removeProviderByConnectionId(connection.id);
            this._onDidChangeTreeData.fire();

            if (this.selectedConnection?.host === connection.host) {
                this.clearRemoteFileView();
            }
        } catch {
            vscode.window.showErrorMessage(`Failed to remove connection for host "${connection.host}".`);
        }
    }

    /** Resets the remote file view to its empty state. */
    private clearRemoteFileView(): void {
        this.selectedConnection = undefined;
        vscode.commands.executeCommand('setContext', 'sshConnectionActive', false);
        this.remoteFilesView?.setProvider(new EmptyRemoteFileProvider());
    }

    public async moveConnectionToFolder(treeItem: SSHConnectionTreeItem): Promise<void> {
        const chosen = await this.pickFolder(treeItem.connection.vFolderTag);
        if (!chosen) {
            return;
        }

        this.assignFolder(treeItem.connection, chosen.path);
    }

    /**
     * Asks which folder to use, offering the ones that already exist.
     *
     * @param current The connection's present folder, marked in the list.
     * @returns The chosen destination, or undefined if the user cancelled.
     */
    private async pickFolder(current?: string): Promise<{ path?: string } | undefined> {
        const ROOT = 'root';
        const NEW = 'new';

        const existing = collectFolderPaths(this.connections.map(conn => conn.vFolderTag));

        const picked = await vscode.window.showQuickPick(
            [
                { label: '$(home) Root', description: 'No folder', action: ROOT },
                ...existing.map(folderPath => ({
                    label: `$(folder) ${folderPath}`,
                    description: folderPath === current ? 'current' : undefined,
                    action: folderPath,
                })),
                { label: '$(new-folder) New folder...', description: 'Type a new path', action: NEW },
            ],
            { placeHolder: 'Move this connection to a folder' }
        );

        if (!picked) {
            return undefined;
        }

        if (picked.action === ROOT) {
            return { path: undefined };
        }

        if (picked.action !== NEW) {
            return { path: picked.action };
        }

        const typed = await vscode.window.showInputBox({
            placeHolder: 'Folder1/SubFolder1',
            prompt: 'Name of the new folder. Use / to nest.',
            value: current,
        });

        return typed === undefined ? undefined : { path: normalizeFolderPath(typed) };
    }

    /**
     * Puts a connection in a folder and persists the change.
     *
     * @param connection The connection to move.
     * @param folderPath The destination, or undefined for the root.
     */
    private assignFolder(connection: ExtendedSSHConnection, folderPath: string | undefined): void {
        const destination = normalizeFolderPath(folderPath);
        if (connection.vFolderTag === destination) {
            return;
        }

        connection.vFolderTag = destination;
        insertOrUpdateConnection(connection);
        this.loadSSHConnections();
        this.rebindProvider(connection.host);

        vscode.window.showInformationMessage(
            `${connection.host} moved to ${destination ? `folder "${destination}"` : 'the root'}.`
        );
    }

    /**
     * Moves a folder, and everything under it, to a new parent.
     *
     * @param sourcePath The folder to move.
     * @param destination The new parent, or undefined for the root.
     */
    private moveFolder(sourcePath: string, destination: string | undefined): void {
        if (isSelfNesting(sourcePath, destination)) {
            vscode.window.showErrorMessage('A folder cannot be moved inside itself.');
            return;
        }

        const newFolderPath = movedFolderPath(sourcePath, destination);
        if (newFolderPath === sourcePath) {
            return;
        }

        for (const connection of this.connections) {
            const rewritten = reparentTag(connection.vFolderTag, sourcePath, newFolderPath);
            if (rewritten !== undefined) {
                connection.vFolderTag = rewritten;
                insertOrUpdateConnection(connection);
            }
        }

        this.loadSSHConnections();
        vscode.window.showInformationMessage(`Folder "${sourcePath}" moved to "${newFolderPath}".`);
    }

    /**
     * Handles items dropped onto a folder, a connection, or empty space.
     *
     * @param items The dragged tree items.
     * @param destination The target folder, or undefined for the root.
     */
    public handleDrop(items: (SSHConnectionTreeItem | SSHFolderTreeItem)[], destination: string | undefined): void {
        for (const item of items) {
            if (item instanceof SSHFolderTreeItem) {
                this.moveFolder(item.folderName, destination);
            } else {
                this.assignFolder(item.connection, destination);
            }
        }
    }

    /**
     * Re-points a remote file provider at the connection object rebuilt by a reload.
     *
     * @param host The connection's ssh_config alias.
     */
    private rebindProvider(host: string): void {
        const updated = this.connections.find(conn => conn.host === host);
        const provider = updated && RemoteFileProvider.getProviderByConnectionId(updated.id);
        if (updated && provider) {
            provider.updateConnection(updated, '/');
            this.remoteFilesView?.setProvider(provider);
        }
    }

    public async connect(treeItem: SSHConnectionTreeItem) {
        const connection = treeItem.connection;

        if (!connection.client) {
            connection.client = new Client();
        }

        try {
            await this.ensureKnownHost(connection);
            await this.tryConnect(connection, treeItem);
        } catch (error) {
            vscode.window.showErrorMessage(`Could not connect to "${connection.host}": ${errorMessage(error)}`);
            this.resetConnectionState(connection, treeItem);
        } finally {
            this.syncMultiCommandPanel();
        }
    }

    /**
     * Ensures the host key is present in known_hosts and has not changed.
     *
     * A first-time host is recorded automatically; a changed key is only
     * accepted after the user confirms, since that is what a MITM looks like.
     */
    private async ensureKnownHost(connection: ExtendedSSHConnection): Promise<void> {
        const { hostname } = connection;
        const port = connection.port ?? SSH_DEFAULT_PORT;
        const scannedFingerprint = getHostKeyFromKeyscan(hostname, port);
        const { exists, key: storedFingerprint } = isKnownHost(hostname);

        if (!exists) {
            addKnownHost(hostname, scannedFingerprint, port);
            vscode.window.showInformationMessage(`Host "${hostname}" added to known_hosts.`);
            return;
        }

        if (storedFingerprint && storedFingerprint !== scannedFingerprint) {
            const selection = await vscode.window.showWarningMessage(
                `The host key fingerprint for ${hostname} has changed. Do you want to update it?`,
                'Yes',
                'No'
            );

            if (selection !== 'Yes') {
                throw new Error('Host key fingerprint update declined by user.');
            }

            removeKnownHost(hostname);
            addKnownHost(hostname, scannedFingerprint, port);
        }
    }

    /** Clears half-established state after a failed connection attempt. */
    private resetConnectionState(connection: ExtendedSSHConnection, treeItem: SSHConnectionTreeItem): void {
        connection.client?.end();
        connection.client = undefined;
        treeItem.connected = false;
        treeItem.updateContextValue();
        this._onDidChangeTreeData.fire(treeItem);
    }

    private async tryConnect(connection: ExtendedSSHConnection, treeItem: SSHConnectionTreeItem) {
        if (!connection.user) {
            const username = await vscode.window.showInputBox({ placeHolder: 'Enter Username' });
            if (!username) {
                throw new Error('Username is required to establish the connection.');
            }
            connection.user = username;
        }

        if (connection.usePrivateKey) {
            connection.identityFile = getIdentityFile(connection.host);
            await this.connectWithSSHKey(connection, treeItem);
            return;
        }

        const password = await vscode.window.showInputBox({ placeHolder: 'Password', password: true });
        if (!password) {
            throw new Error('Connection cancelled. No password provided.');
        }

        connection.password = password;
        await this.connectWithPassword(connection, treeItem, password);
    }

    public disconnect(treeItem: SSHConnectionTreeItem) {
        const connection = treeItem.connection;

        if (!connection.client) {
            vscode.window.showInformationMessage(`Not connected to ${connection.host}.`);
            return;
        }

        connection.client.end();
        connection.client = undefined;
        treeItem.connected = false;
        treeItem.updateContextValue();

        const terminal = this.terminals.get(connection.id);
        if (terminal) {
            terminal.dispose();
            this.terminals.delete(connection.id);
        }

        // A reconnect opens a fresh shell in the home directory, so the
        // remembered directory would wrongly suppress the next change.
        this.pathFollower?.forget(connection.id);
        void this.tunnels?.disposeConnection(connection.id);

        const remoteFileProvider = RemoteFileProvider.getProviderByConnectionId(connection.id);
        if (remoteFileProvider) {
            remoteFileProvider.cleanup();
        }

        if (this.selectedConnection && this.selectedConnection.id === connection.id) {
            this.selectedConnection = this.connections.find(conn => conn.client);

            if (this.selectedConnection) {
                const newRemoteFileProvider = RemoteFileProvider.createOrGetProvider(this.selectedConnection, '/');
                this.remoteFilesView?.setProvider(newRemoteFileProvider);
                newRemoteFileProvider.refresh();
            }
        }

        if (this.multiCommandPanel) {
            const connectedConnections = this.connections.filter(conn => conn.client);
            this.multiCommandPanel.updateConnections(connectedConnections);
        }

        this.refresh();

        vscode.window.showInformationMessage(`Connection to ${connection.host} has been closed.`);
    }
    /** Waits for the SSH handshake to finish, then opens the terminal. */
    private waitForConnection(connection: ExtendedSSHConnection, treeItem: SSHConnectionTreeItem): Promise<void> {
        const client = connection.client!;

        return new Promise<void>((resolve, reject) => {
            const detach = () => {
                client.removeListener('ready', onReady);
                client.removeListener('error', onError);
            };

            const onReady = () => {
                detach();
                vscode.window.showInformationMessage(`Connected to ${connection.host}`);

                treeItem.connected = true;
                treeItem.updateContextValue();
                this._onDidChangeTreeData.fire(treeItem);

                const terminal = vscode.window.createTerminal({
                    name: `${connection.user}@${connection.host}`,
                    pty: new SSHPseudoterminal(client),
                });

                this.registerTerminal(connection, terminal);
                terminal.show();

                void this.loadRemoteFiles(connection, '/');
                resolve();
            };

            const onError = (err: Error) => {
                detach();
                reject(err);
            };

            client.once('ready', onReady);
            client.once('error', onError);
        });
    }

    public handleTerminalSelectionChange(terminal: vscode.Terminal) {
        const connection = this.connections.find(conn => {
            if (!conn.user || !conn.host) {
                return false;
            }
            return `${conn.user}@${conn.host}` === terminal.name;
        });

        if (connection) {
            // Validate connection properties before creating the tree item
            const label = connection.user ? `${connection.user}@${connection.host}` : connection.host;
            if (!label) {
                console.error('Invalid connection label:', connection);
                vscode.window.showErrorMessage('Failed to select connection: Invalid connection label.');
                return;
            }

            const treeItem = new SSHConnectionTreeItem(connection, !!connection.client);
            this.selectConnection(treeItem);

            try {
                this._onDidChangeTreeData.fire(treeItem);
            } catch (error) {
                console.error('Error updating tree view:', error);
                vscode.window.showErrorMessage('Failed to update tree view.');
            }
        }
    }

    public handleTerminalClose(terminal: vscode.Terminal) {
        const connectionId = Array.from(this.terminals.entries()).find(([_, term]) => term === terminal)?.[0];

        if (connectionId) {
            const connection = this.connections.find(conn => conn.id === connectionId);

            if (connection) {
                const treeItem = new SSHConnectionTreeItem(connection, !!connection.client);

                // Reuse the disconnect() function
                this.disconnect(treeItem);
            }
        }
    }

    public handleRemoteFileSelectionChange(resourceUri: vscode.Uri) {
        const authority = resourceUri.authority.toLowerCase();
        const connection = this.connections.find(
            conn => `${conn.user}@${conn.hostname}:${conn.port ?? SSH_DEFAULT_PORT}`.toLowerCase() === authority
        );
        if (connection) {
            this.loadSSHConnections();
            const treeItem = new SSHConnectionTreeItem(connection, !!connection.client);
            this.selectConnection(treeItem);
            this._onDidChangeTreeData.fire(treeItem);
        }
    }

    private async connectWithPassword(
        connection: ExtendedSSHConnection,
        treeItem: SSHConnectionTreeItem,
        password: string
    ) {
        const connected = this.waitForConnection(connection, treeItem);

        connection.client!.connect({
            host: connection.hostname,
            username: connection.user,
            password,
            port: connection.port ?? SSH_DEFAULT_PORT,
        });

        await connected;
    }

    private async connectWithSSHKey(connection: ExtendedSSHConnection, treeItem: SSHConnectionTreeItem) {
        const identityFile = connection.identityFile!;

        let privateKey: Buffer;
        try {
            privateKey = Buffer.from(fileUtils.readFile(identityFile));
        } catch (error) {
            throw new Error(`Failed to read private key: ${errorMessage(error)}`);
        }

        let passphrase = connection.passphrase;

        // An unencrypted key parses on the first try and needs no passphrase.
        const firstParse = utils.parseKey(privateKey, passphrase);
        if (firstParse instanceof Error && /encrypted|passphrase/i.test(firstParse.message)) {
            passphrase = await vscode.window.showInputBox({
                placeHolder: 'Passphrase for private key',
                password: true,
            });

            if (!passphrase) {
                throw new Error('Passphrase not provided. Connection cancelled.');
            }
        }

        const parsedKey = utils.parseKey(privateKey, passphrase);
        if (parsedKey instanceof Error) {
            throw new Error(`Invalid private key "${identityFile}": ${parsedKey.message}`);
        }

        connection.passphrase = passphrase;

        // The key is decrypted in process; the passphrase never reaches argv
        // or an environment variable.
        const connected = this.waitForConnection(connection, treeItem);

        connection.client!.connect({
            // `hostname` is the address; `host` is only the ssh_config alias.
            host: connection.hostname,
            port: connection.port ?? SSH_DEFAULT_PORT,
            username: connection.user,
            privateKey,
            passphrase,
        });

        await connected;
    }

    private async loadRemoteFiles(connection: ExtendedSSHConnection, remotePath: string) {
        if (!connection.client) {
            vscode.window.showErrorMessage('SSH connection is not established.');
            return;
        }

        // Retrieve or create a RemoteFileProvider for the connection
        let remoteFileProvider = RemoteFileProvider.getProviderByConnectionId(connection.id);
        if (!remoteFileProvider) {
            remoteFileProvider = new RemoteFileProvider(connection, remotePath);
            if (this.detailsView) {
                remoteFileProvider.setDetailsView(this.detailsView);
            }
            const remoteFileViewTitle = new RemoteFileViewTitle(`Connection: ${connection.user}@${connection.host}`);
            remoteFileProvider.setTitleItem(remoteFileViewTitle);
            this.remoteFilesView?.setProvider(remoteFileProvider);
        } else {
            remoteFileProvider.updateConnection(connection, remotePath);
        }

        remoteFileProvider.refresh();
        vscode.commands.executeCommand('setContext', 'sshConnectionActive', true);
    }

    public getRemoteFileProvider(connectionId: string): RemoteFileProvider | undefined {
        return RemoteFileProvider.getProviderByConnectionId(connectionId);
    }

    public setDecorationProvider(provider: SSHTreeDecorationProvider): void {
        this.decorationProvider = provider;
    }

    public setRemoteFilesView(view: RemoteFilesView): void {
        this.remoteFilesView = view;
    }

    public setPathFollower(follower: TerminalPathFollower): void {
        this.pathFollower = follower;
    }

    public setTunnelManager(manager: TunnelManager): void {
        this.tunnels = manager;
    }

    /**
     * Asks for a tunnel's details and opens it on the selected connection.
     *
     * @param treeItem The connection to tunnel over.
     */
    public async addTunnel(treeItem: SSHConnectionTreeItem): Promise<void> {
        const connection = treeItem.connection;

        if (!connection.client) {
            vscode.window.showErrorMessage(`Connect to ${connection.host} before opening a tunnel.`);
            return;
        }

        const config = await promptForTunnel(connection.host);
        if (!config || !this.tunnels) {
            return;
        }

        const entry = await this.tunnels.add(connection.id, config);
        if (!entry) {
            vscode.window.showErrorMessage(
                `A tunnel is already listening on ${config.bindAddress}:${config.listenPort}.`
            );
            return;
        }

        this._onDidChangeTreeData.fire();

        if (entry.state === 'error') {
            vscode.window.showErrorMessage(`Tunnel failed to start: ${entry.error}`);
            return;
        }

        // Confirmed explicitly: the tunnel is a row under its connection, and
        // without this there is nothing to distinguish "listening" from
        // "the command did nothing".
        vscode.window.showInformationMessage(
            `Tunnel open on ${connection.host}: ${tunnelLabel(config)} (${tunnelFlag(config)}).`
        );
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
        this.decorationProvider?.refresh();

        this.syncMultiCommandPanel();
    }

    public setMultiCommandPanel(panel: MultiCommandPanel): void {
        this.multiCommandPanel = panel;
        const connectedConnections = this.connections.filter(conn => conn.client);
        this.multiCommandPanel.updateConnections(connectedConnections);
    }

    public openMultiCommandPanel(): void {
        // The view lives in the sidebar now, so it is focused by its own
        // generated command rather than by revealing a panel container.
        vscode.commands.executeCommand('multiCommandView.focus');
        if (this.multiCommandPanel) {
            const connectedConnections = this.connections.filter(conn => conn.client);
            this.multiCommandPanel.updateConnections(connectedConnections);
        }
    }

    public setDetailsView(provider: FileDetailsViewProvider) {
        this.detailsView = provider;
        RemoteFileProvider.forEachProvider(p => p.setDetailsView(provider));
    }
}

/**
 * Builds the secondary text shown beside a connection's name.
 *
 * Returns nothing when it would only repeat the alias already used as the
 * label, so `Host example.com` with no User stays a single word.
 *
 * @param connection The connection to describe.
 * @returns The description text, or undefined.
 */
export function describeTarget(connection: ExtendedSSHConnection): string | undefined {
    const target = connection.user ? `${connection.user}@${connection.hostname}` : connection.hostname;
    return target && target !== connection.host ? target : undefined;
}

/**
 * Builds the activity bar badge showing how many connections are live.
 *
 * The icon's circle is drawn at exactly the badge's size and position, so the
 * badge lands on it and covers the cursor underneath.
 *
 * @param connections The known connections.
 * @returns A badge, or undefined when nothing is connected.
 */
export function activeConnectionBadge(connections: ExtendedSSHConnection[]): vscode.ViewBadge | undefined {
    const active = connections.filter(connection => connection.client).length;

    return active === 0
        ? undefined
        : { value: active, tooltip: `${active} active SSH connection${active === 1 ? '' : 's'}` };
}

/**
 * Builds the hover text listing a connection's ssh_config settings.
 *
 * @param connection The connection to describe.
 * @returns A multi-line tooltip.
 */
export function connectionTooltip(connection: ExtendedSSHConnection): string {
    const lines = [
        `Host: ${connection.host}`,
        `HostName: ${connection.hostname}`,
        connection.user ? `User: ${connection.user}` : undefined,
        `Port: ${connection.port ?? SSH_DEFAULT_PORT}`,
        connection.identityFile ? `IdentityFile: ${connection.identityFile}` : undefined,
        connection.vFolderTag ? `Folder: ${connection.vFolderTag}` : undefined,
    ];

    return lines.filter((line): line is string => line !== undefined).join('\n');
}

export class SSHConnectionTreeItem extends vscode.TreeItem {
    constructor(
        public readonly connection: ExtendedSSHConnection,
        public connected: boolean,
        expandable = false
    ) {
        // The label is the ssh_config alias, the name the user chose. The
        // target goes in the description, so the two carry different
        // information instead of repeating `user@host` twice.
        super(
            connection.host || 'Unknown Host',
            expandable ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
        );

        // Drives the label colour through SSHTreeDecorationProvider; the
        // explicit label above still wins for display.
        this.resourceUri = connectionResourceUri(connection.id);

        // Without a stable id VS Code identifies elements by object, and every
        // refresh builds new ones: an expanded connection collapses again, so
        // a tunnel added here disappears the moment the tree refreshes.
        this.id = `connection:${connection.id}`;
        this.description = describeTarget(connection);
        this.tooltip = connectionTooltip(connection);
        this.contextValue = 'sshConnection';

        this.updateContextValue();
    }

    updateContextValue() {
        this.contextValue = this.connected ? 'sshConnectionConnected' : 'sshConnectionDisconnected';
        this.iconPath = new vscode.ThemeIcon(
            this.connected ? 'vm-active' : 'vm-outline',
            this.connected ? new vscode.ThemeColor('terminal.ansiGreen') : undefined
        );
    }
}

export class SSHFolderTreeItem extends vscode.TreeItem {
    constructor(
        public readonly folderName: string,
        connectionCount?: number
    ) {
        super(folderName.split('/').pop()!, vscode.TreeItemCollapsibleState.Collapsed);

        const count =
            connectionCount === undefined ? '' : ` — ${connectionCount} connection${connectionCount === 1 ? '' : 's'}`;
        this.tooltip = `${folderName}${count}`;
        // The count is a decoration badge, not description text, so it cannot
        // be mistaken for part of the folder name.
        this.id = `folder:${folderName}`;
        this.resourceUri = folderResourceUri(folderName);
        this.contextValue = 'sshFolder';
        this.iconPath = vscode.ThemeIcon.Folder;
    }
}

export class MultiCommandPanel {
    private connections: ExtendedSSHConnection[];
    private terminals: Map<string, vscode.Terminal> = new Map();

    constructor(
        private readonly view: vscode.WebviewView,
        connections: ExtendedSSHConnection[]
    ) {
        this.connections = connections;
        // localResourceRoots must be set explicitly, or the panel's own
        // stylesheet and script cannot be loaded.
        this.view.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(getExtensionUri(), 'resources')],
        };

        this.view.webview.onDidReceiveMessage(message => {
            this.sendCommandToConnections(message.command, message.selectedConnections);
        });

        this.view.onDidChangeVisibility(() => {
            if (this.view.visible) {
                this.updateWebview();
            }
        });

        this.updateWebview();
    }

    public updateConnections(connections: ExtendedSSHConnection[]): void {
        const establishedConnections = connections.filter(conn => conn.client);

        this.connections = establishedConnections;
        this.updateWebview();
    }

    private updateWebview(): void {
        const htmlPath = MULTICOMMANDPANEL_HTML_PATH();
        const cssPath = this.view.webview.asWebviewUri(vscode.Uri.file(MULTICOMMANDPANEL_CSS_PATH()));
        const jsPath = this.view.webview.asWebviewUri(vscode.Uri.file(MULTICOMMANDPANEL_JS_PATH()));

        const htmlContent = fileUtils
            .readFile(htmlPath)
            .replace('multiCommandPanel.css', cssPath.toString())
            .replace('multiCommandPanel.js', jsPath.toString())
            .replace(/\$\{cspSource\}/g, this.view.webview.cspSource);

        this.view.webview.html = htmlContent;

        const connectionOptions = this.connections.map(conn => ({
            id: conn.id,
            user: conn.user,
            host: conn.host,
        }));
        this.view.webview.postMessage({ connections: connectionOptions });
    }

    private sendCommandToConnections(command: string, selectedConnectionIds: string[]) {
        vscode.window.terminals.forEach(terminal => {
            const matchingConnection = this.connections.find(conn => terminal.name === `${conn.user}@${conn.host}`);
            if (matchingConnection) {
                this.terminals.set(matchingConnection.id, terminal);
            }
        });

        const selectedConnections = this.connections.filter(conn => selectedConnectionIds.includes(conn.id));

        if (selectedConnections.length === 0) {
            vscode.window.showErrorMessage('No connections selected.');
            return;
        }

        selectedConnections.forEach(connection => {
            const terminalName = `${connection.user}@${connection.host}`;
            const existingTerminal = this.terminals.get(connection.id);
            if (existingTerminal) {
                existingTerminal.sendText(command);
            } else {
                vscode.window.showErrorMessage(`No existing terminal found for ${terminalName}`);
            }
        });
    }
}
