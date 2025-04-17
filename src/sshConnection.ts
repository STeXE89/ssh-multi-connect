import * as vscode from 'vscode';
import { ProviderResult } from 'vscode';
import * as fileUtils from './utils/fileUtils';
import { Client, utils } from 'ssh2';
import { RemoteFileProvider, RemoteFileViewTitle, EmptyRemoteFileProvider } from './remoteFile';
import { SSH_DEFAULT_PORT, SSHConnection, insertOrUpdateConnection, getAllConnections, removeConnection, createIdentityFile, getIdentityFile, addKnownHost, removeKnownHost, isKnownHost, getHostKeyFromKeyscan } from './utils/sshUtils';

// SSHConnection Interface
export interface ExtendedSSHConnection extends SSHConnection {
    id: string;
    client?: Client;
    usePrivateKey?: boolean;
    password?: string;
    privateKey?: Buffer;
    passphrase?: string;
    fingerprint?: string;
}

// Function to add an SSH connection
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

        const port = await vscode.window.showInputBox({ placeHolder: `Port (default ${SSH_DEFAULT_PORT})`, value: SSH_DEFAULT_PORT.toString() });
        const usePrivateKey = await vscode.window.showQuickPick(['Yes', 'No'], {
            placeHolder: 'Use SSH Key?'
        });
        if (!usePrivateKey) {
            vscode.window.showErrorMessage('SSH Key usage selection is required.');
            return;
        }

        let identityFile: string | undefined;
        if (usePrivateKey === 'Yes') {
            // Use the utility function to create the identity file
            identityFile = createIdentityFile(host);

            // Open the identity file for the user to paste the private key
            const document = await vscode.workspace.openTextDocument(identityFile);
            await vscode.window.showTextDocument(document);

            // Show the warning message and wait for the user to confirm they have pasted the key
            await vscode.window.showWarningMessage('Paste your SSH private key into the opened file and save it, then click Done.', 'Done');

            // Wait for the user to save the file
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

            // Close the editor
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        }

        const existingConnection = sshViewProvider.connections.find((conn: ExtendedSSHConnection) => conn.host === host && conn.user === user);
        if (existingConnection) {
            vscode.window.showInformationMessage(`Connection to ${host} as ${user} already exists.`);
            return;
        }

        const newConnection = {
            host,
            hostname,
            user,
            port: port ? parseInt(port) : SSH_DEFAULT_PORT,
            identityFile: usePrivateKey === 'Yes' ? identityFile : undefined
        };

        // Use the utility function to insert or update the connection in the SSH config
        insertOrUpdateConnection(newConnection);

        sshViewProvider.loadSSHConnections();

        sshViewProvider.connections.push({
            id: host,
            host,
            hostname,
            user,
            port: port ? parseInt(port) : SSH_DEFAULT_PORT,
            usePrivateKey: usePrivateKey === 'Yes',
            identityFile: usePrivateKey === 'Yes' ? identityFile : undefined
        });

        const uniqueConnections = sshViewProvider.connections.filter((conn, index, self) =>
            index === self.findIndex((c) => (
                c.host === conn.host && c.user === conn.user
            ))
        );

        sshViewProvider.connections = uniqueConnections;
        sshViewProvider.refresh();

    } catch (error: any) {
        vscode.window.showErrorMessage(`Error adding SSH connection: ${error.message}`);
    }
}

// Function to check if the host is in known_hosts
async function checkKnownHosts(connection: ExtendedSSHConnection): Promise<boolean> {
    const { hostname } = connection;
    try {
        const { exists } = isKnownHost(hostname);
        return exists;
    } catch (error) {
        console.error(`Error during known hosts check: ${error instanceof Error ? error.message : error}`);
        throw new Error(`Failed to check known hosts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

// Function to update the known_hosts file
async function updateKnownHosts(connection: ExtendedSSHConnection): Promise<void> {
    const { hostname } = connection;
    try {
        const fingerprint = getHostKeyFromKeyscan(hostname);
        const { exists, key: existingFingerprint } = isKnownHost(hostname);

        if (exists) {
            if (existingFingerprint !== fingerprint) {
                const selection = await vscode.window.showWarningMessage(
                    `The host key fingerprint for ${hostname} has changed. Do you want to update it?`,
                    'Yes', 'No'
                );

                if (selection === 'Yes') {
                    removeKnownHost(hostname);
                    addKnownHost(hostname, fingerprint);
                } else {
                    throw new Error('Host key fingerprint update declined by user.');
                }
            }
        } else {
            throw new Error('Host is not in known_hosts.');
        }
    } catch (error) {
        console.error(`Error during known hosts update: ${error instanceof Error ? error.message : error}`);
        throw new Error(`Failed to update known hosts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

// Main class for managing SSH connections
export class SSHViewProvider implements vscode.TreeDataProvider<SSHConnectionTreeItem | SSHFolderTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SSHConnectionTreeItem | undefined | void> = new vscode.EventEmitter<SSHConnectionTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<SSHConnectionTreeItem | undefined | void> = this._onDidChangeTreeData.event;

    public connections: ExtendedSSHConnection[] = [];
    private selectedConnection?: ExtendedSSHConnection;
    private terminals: Map<string, vscode.Terminal> = new Map();
    private remoteFileProviders: Map<string, RemoteFileProvider> = new Map();

    constructor(private context: vscode.ExtensionContext) {
        this.loadSSHConnections();

        const sshTreeView = vscode.window.createTreeView('sshConnectionsView', {
            treeDataProvider: this,
            showCollapseAll: true
        });

        sshTreeView.onDidChangeSelection(event => {
            if (event.selection.length > 0 && event.selection[0] instanceof SSHConnectionTreeItem) {
                this.selectConnection(event.selection[0]);
            }
        });

        context.subscriptions.push(sshTreeView);

        vscode.window.onDidCloseTerminal(this.handleTerminalClose.bind(this));
    }

    // Methods required by TreeDataProvider
    getTreeItem(element: SSHConnectionTreeItem): vscode.TreeItem {
        return element;
    }

    // Method to get the children of a tree item
    getChildren(element?: SSHConnectionTreeItem | SSHFolderTreeItem): Thenable<(SSHConnectionTreeItem | SSHFolderTreeItem)[]> | ProviderResult<SSHConnectionTreeItem[]> {
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
    
            // Create folder items for top-level folders
            const folderItems = Array.from(folderMap.keys()).map(folderName => new SSHFolderTreeItem(folderName));
            const rootItems = rootConnections.map(conn => new SSHConnectionTreeItem(conn, !!conn.client));
    
            // Combine folder items and root connections
            return Promise.resolve([...folderItems, ...rootItems]);
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
            const subFolderItems = Array.from(subFolderMap.keys()).map(subFolderName => new SSHFolderTreeItem(`${currentFolder}/${subFolderName}`));
            const connectionItems = folderConnections.map(conn => new SSHConnectionTreeItem(conn, !!conn.client));
    
            // Combine subfolder items and connections
            return Promise.resolve([...subFolderItems, ...connectionItems]);
        }
    
        return Promise.resolve([]);
    }

    // Method to get the selected connection
    getSelectedConnection(): ExtendedSSHConnection | undefined {
        return this.selectedConnection;
    }

    loadSSHConnections() {
        try {
            const connections = getAllConnections();
    
            this.connections = connections
                .filter(conn => conn.host) // Ensure host is defined
                .map(conn => ({
                    ...conn,
                    id: conn.host,
                    client: undefined,
                    usePrivateKey: !!conn.identityFile,
                    vFolderTag: conn.vFolderTag,
                }))
                .sort((a, b) => {
                    if (a.vFolderTag && b.vFolderTag) {
                        return a.vFolderTag.localeCompare(b.vFolderTag);
                    } else if (a.vFolderTag) {
                        return -1;
                    } else if (b.vFolderTag) {
                        return 1;
                    }
                    const hostComparison = a.host.localeCompare(b.host);
                    if (hostComparison !== 0) {
                        return hostComparison;
                    }
                    if (a.user === undefined && b.user !== undefined) {
                        return 1;
                    }
                    if (a.user !== undefined && b.user === undefined) {
                        return -1;
                    }
                    return 0;
                });
    
            this._onDidChangeTreeData.fire();
        } catch (error) {
            console.error('Error loading SSH connections:', error);
            vscode.window.showErrorMessage('Failed to load SSH connections.');
        }
    }

    // Connection selection
    public selectConnection(treeItem: SSHConnectionTreeItem) {
        const connection = treeItem.connection;
        const terminal = this.terminals.get(connection.id);
    
        if (connection.client) {
            this.selectedConnection = connection;
    
            // Use the static method to create or get the RemoteFileProvider
            const remoteFileProvider = RemoteFileProvider.createOrGetProvider(connection, '/');
            this.remoteFileProviders.set(connection.id, remoteFileProvider);
    
            // Register the RemoteFileProvider with the tree view
            vscode.window.registerTreeDataProvider('remoteFilesView', remoteFileProvider);
    
            // Update the title to reflect the current connection
            const titleItem = new RemoteFileViewTitle(`Connected to ${connection.host}`);
            remoteFileProvider.setTitleItem(titleItem);
            remoteFileProvider.refresh();
        } else {
            this.selectedConnection = undefined;
    
            // Reset the remote file view to an empty state
            const emptyProvider = new EmptyRemoteFileProvider();
            const emptyTitleItem = new RemoteFileViewTitle('No Active Connection');
            emptyProvider.setTitleItem(emptyTitleItem);
            vscode.window.registerTreeDataProvider('remoteFilesView', emptyProvider);
        }
    
        if (terminal) {
            terminal.show();
        }
    
        vscode.commands.executeCommand('setContext', 'sshConnectionActive', !!this.selectedConnection);
    
        // Ensure the remote file view is refreshed and displayed
        if (this.selectedConnection) {
            this.loadRemoteFiles(this.selectedConnection, '/');
        }
    }

    // Method to register a terminal for an SSH connection
    public registerTerminal(connection: ExtendedSSHConnection, terminal: vscode.Terminal) {
        this.terminals.set(connection.id, terminal);
    }

    removeConnection(treeItem: SSHConnectionTreeItem) {
        const connection = treeItem.connection;
    
        if (!connection.host || !connection.user) {
            vscode.window.showErrorMessage('Host and Username are required. Cannot remove connection.');
            return;
        }
    
        console.log('Removing connection for host:', connection.host, 'and user:', connection.user);
    
        try {
            // Use the utility function to remove the connection from the SSH config file
            removeConnection(connection.host);
    
            // Remove the connection from the in-memory list
            this.connections = this.connections.filter(conn => !(conn.host === connection.host && conn.user === connection.user));
    
            // Refresh the tree view
            try {
                console.log('Firing tree data change event for:', treeItem);
                this._onDidChangeTreeData.fire(treeItem);
            } catch (error) {
                console.error('Error firing tree data change event:', error);
                vscode.window.showErrorMessage('Failed to refresh the tree view.');
            }
    
            // Dispose of the terminal associated with the connection
            const terminalName = `${connection.user}@${connection.host}`;
            vscode.window.terminals.forEach(terminal => {
                if (terminal.name === terminalName) {
                    terminal.dispose();
                }
            });
    
            // If the removed connection was the selected connection, reset the context and remote file view
            if (this.selectedConnection && this.selectedConnection.host === connection.host && this.selectedConnection.user === connection.user) {
                vscode.commands.executeCommand('setContext', 'sshConnectionActive', false);
                const remoteFileProvider = new EmptyRemoteFileProvider();
                vscode.window.registerTreeDataProvider('remoteFilesView', remoteFileProvider);
                this.selectedConnection = undefined;
            }
    
            vscode.window.showInformationMessage(`Connection for host "${connection.host}" has been removed.`);
        } catch (error) {
            console.error('Error removing connection:', error);
            vscode.window.showErrorMessage(`Failed to remove connection for host "${connection.host}".`);
        }
    }

    public async moveConnectionToFolder(treeItem: SSHConnectionTreeItem): Promise<void> {
        const connection = treeItem.connection;
    
        const folderName = await vscode.window.showInputBox({
            placeHolder: 'Enter the name of the virtual folder (e.g., Folder1/SubFolder1)',
            prompt: 'Move this connection to a virtual folder (leave empty to remove from folders)',
        });
    
        if (folderName !== undefined) {
            // Preserve the current connection state
            const activeClient = connection.client;
            const activePassword = connection.password;
            const activePrivateKey = connection.privateKey;
            const activePassphrase = connection.passphrase;
    
            // Preserve the current RemoteFileProvider
            const remoteFileProvider = this.remoteFileProviders.get(connection.id);
    
            // Update the vFolderTag
            connection.vFolderTag = folderName.trim() || undefined;
    
            // Update the SSH config file
            insertOrUpdateConnection(connection);
    
            // Refresh the view without resetting the RemoteFileProvider
            this.loadSSHConnections();
    
            // Restore the connection state
            const updatedConnection = this.connections.find(
                (conn) => conn.host === connection.host && conn.user === connection.user
            );
            if (updatedConnection) {
                updatedConnection.client = activeClient;
                updatedConnection.password = activePassword;
                updatedConnection.privateKey = activePrivateKey;
                updatedConnection.passphrase = activePassphrase;
    
                // Reassociate the RemoteFileProvider with the updated connection
                if (remoteFileProvider) {
                    this.remoteFileProviders.set(updatedConnection.id, remoteFileProvider);
                    remoteFileProvider.updateConnection(updatedConnection, '/');
                    vscode.window.registerTreeDataProvider('remoteFilesView', remoteFileProvider);
                    remoteFileProvider.refresh();
                }
            }
    
            vscode.window.showInformationMessage(`Connection moved to folder: ${folderName || 'Root'}`);
        }
    }

    // Method to connect to an SSH connection
    connect(treeItem: SSHConnectionTreeItem) {
        const connection = treeItem.connection;
    
        if (!connection.client) {
            connection.client = new Client();
        }
    
        checkKnownHosts(connection).then(async (isHostInKnownHosts) => {
            if (!isHostInKnownHosts) {
                // Host is not in known_hosts, try to connect and then add the host key                
                try {
                    await this.tryConnect(connection, treeItem);
                    const newHostKey = getHostKeyFromKeyscan(connection.hostname);
                    addKnownHost(connection.hostname, newHostKey);
                    vscode.window.showInformationMessage(`Host "${connection.hostname}" added to known_hosts.`);
                } catch (error) {
                    vscode.window.showErrorMessage(`Failed to add host "${connection.hostname}" to known_hosts: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    this.removeConnectionFromList(connection);
                }
            } else {
                // Host is in known_hosts, check if the host key has changed
                try {
                    await updateKnownHosts(connection);
                    await this.tryConnect(connection, treeItem);
                } catch (error) {
                    vscode.window.showErrorMessage(`Error during known hosts verification: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    this.removeConnectionFromList(connection);
                }
            }
        }).catch(error => {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Error during known hosts verification: ${errorMessage}`);
            this.removeConnectionFromList(connection);
        });
    }

    // Helper function to try connecting to the SSH host
    private async tryConnect(connection: ExtendedSSHConnection, treeItem: SSHConnectionTreeItem) {
        if (!connection.user) {
            const username = await vscode.window.showInputBox({ placeHolder: 'Enter Username' });
            if (username) {
                connection.user = username;
            } else {
                vscode.window.showErrorMessage('Username is required to establish the connection.');
                this.removeConnectionFromList(connection);
                return;
            }
        }
    
        if (connection.usePrivateKey) {
            try {
                const identityFile = getIdentityFile(connection.host);
                connection.identityFile = identityFile;
                await this.connectWithSSHKey(connection, treeItem);
            } catch (error) {
                vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Unknown error occurred while retrieving the identity file.');
                this.removeConnectionFromList(connection);
            }
        } else {
            const password = await vscode.window.showInputBox({ placeHolder: 'Password', password: true });
            if (password) {
                connection.password = password;
                await this.connectWithPassword(connection, treeItem, password);
            } else {
                vscode.window.showErrorMessage('Connection cancelled. No password provided.');
                this.removeConnectionFromList(connection);
            }
        }
    }

    // Method to disconnect from an SSH connection
    public disconnect(treeItem: SSHConnectionTreeItem) {
        const connection = treeItem.connection;
    
        if (connection.client) {
            // End the SSH client connection
            connection.client.end();
            connection.client = undefined;
        }
    
        // Remove the terminal associated with the connection
        const terminal = this.terminals.get(connection.id);
        if (terminal) {
            terminal.dispose();
            this.terminals.delete(connection.id);
        }
    
        // Cleanup the RemoteFileProvider for the connection
        const remoteFileProvider = RemoteFileProvider.getProviderByConnectionId(connection.id);
        if (remoteFileProvider) {
            remoteFileProvider.cleanup();
        }
    
        // If the disconnected connection was the selected connection, reset the remote file view
        if (this.selectedConnection && this.selectedConnection.id === connection.id) {
            const emptyProvider = new EmptyRemoteFileProvider();
            vscode.window.registerTreeDataProvider('remoteFilesView', emptyProvider);
            this.selectedConnection = undefined;
            vscode.commands.executeCommand('setContext', 'sshConnectionActive', false);
        }
    
        this.removeConnectionFromList(connection);
    
        vscode.window.showInformationMessage(`Connection to ${connection.host} has been removed.`);
    }

    // Method to remove a connection from the list
    private removeConnectionFromList(connection: ExtendedSSHConnection): void {
        // Remove the connection from the connections array
        this.connections = this.connections.filter(conn => conn.id !== connection.id);
    
        // Notify the TreeDataProvider to refresh the view
        this._onDidChangeTreeData.fire();
        this.loadSSHConnections();
    }

    // Method to handle connection ready event
    private async handleConnectionReady(connection: ExtendedSSHConnection, treeItem: SSHConnectionTreeItem, terminalArgs: string) {
        connection.client!.on('ready', async () => {
            console.log("Connection ready");
            vscode.window.showInformationMessage(`Connected to ${connection.host}`);
    
            treeItem.connected = true;
            treeItem.updateContextValue();
            this._onDidChangeTreeData.fire(treeItem);
    
            // Use the existing SSH connection to open the terminal
            const terminalName = `${connection.user}@${connection.host}`;
            const terminal = vscode.window.createTerminal({
                name: terminalName,
                shellPath: '/bin/sh',
                shellArgs: ['-c', terminalArgs]
            });
    
            this.registerTerminal(connection, terminal);
            terminal.show();
            await this.loadRemoteFiles(connection, '/');
        });
    }

    // Method to handle terminal selection change
    public handleTerminalSelectionChange(terminal: vscode.Terminal) {
        console.log('Terminal selected:', terminal.name);
    
        const connection = this.connections.find(conn => {
            console.log('Checking connection:', conn);
            if (!conn.user || !conn.host) {
                console.warn('Connection has undefined user or host:', conn);
                return false;
            }
            return `${conn.user}@${conn.host}` === terminal.name;
        });
    
        if (connection) {
            console.log('Connection found:', connection);
    
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
        } else {
            console.warn('No matching connection found for terminal:', terminal.name);
        }
    }

    // Method to handle terminal close event
    public handleTerminalClose(terminal: vscode.Terminal) {
        const connectionId = Array.from(this.terminals.entries()).find(([_, term]) => term === terminal)?.[0];
    
        if (connectionId) {
            const connection = this.connections.find(conn => conn.id === connectionId);
    
            if (connection) {
                // Create a tree item for the connection
                const treeItem = new SSHConnectionTreeItem(connection, !!connection.client);
    
                // Reuse the disconnect() function
                this.disconnect(treeItem);
    
                vscode.window.showInformationMessage(`Terminal for connection ${connection.host} has been closed.`);
            }
        }
    }

    // Method to handle remote file view selection change
    public handleRemoteFileSelectionChange(resourceUri: vscode.Uri) {
        const connection = this.connections.find(conn => resourceUri.authority === `${conn.user}@${conn.hostname}:${conn.port}`);
        if (connection) {
            this.loadSSHConnections();
            const treeItem = new SSHConnectionTreeItem(connection, !!connection.client);
            this.selectConnection(treeItem);
            this._onDidChangeTreeData.fire(treeItem);
        }
    }

    private async connectWithPassword(connection: ExtendedSSHConnection, treeItem: SSHConnectionTreeItem, password: string) {
        try {
            const installed = await this.isSSHPassInstalled();
            if (!installed) {
                vscode.window.showErrorMessage(`'sshpass' is not installed locally. Please install it to proceed.`);
                this.removeConnectionFromList(connection);
                return;
            }
    
            connection.client!.on('error', (err) => {
                vscode.window.showErrorMessage(`Failed to connect: ${err.message}`);
                console.error(`Failed to connect: ${err.message}`);
                this.removeConnectionFromList(connection);
            });
    
            await this.handleConnectionReady(connection, treeItem, `sshpass -p ${password} ssh -o StrictHostKeyChecking=no ${connection.user}@${connection.hostname} -p ${connection.port}`);
    
            connection.client!.connect({
                host: connection.hostname,
                username: connection.user,
                password: password,
                port: connection.port ?? SSH_DEFAULT_PORT,
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error connecting with password: ${error.message}`);
            this.removeConnectionFromList(connection);
        }
    }

    private async connectWithSSHKey(connection: ExtendedSSHConnection, treeItem: SSHConnectionTreeItem) {
        try {
            const installed = await this.isSSHPassInstalled();
            if (!installed) {
                vscode.window.showErrorMessage(`'sshpass' is not installed locally. Please install it to proceed.`);
                this.removeConnectionFromList(connection);
                return;
            }
    
            const identityFile = connection.identityFile!;
            let passphrase: string | undefined = connection.passphrase;
    
            try {
                const privateKey = fileUtils.readFile(identityFile);
                const parsedKey = utils.parseKey(Buffer.from(privateKey));
    
                if (parsedKey instanceof Error && parsedKey.message.toLowerCase().includes('encrypted')) {
                    // The private key is protected by a passphrase
                    passphrase = await vscode.window.showInputBox({ placeHolder: 'Passphrase for private key', password: true });
                    if (!passphrase) {
                        vscode.window.showErrorMessage('Passphrase not provided. Connection cancelled.');
                        this.removeConnectionFromList(connection);
                        return;
                    }
                }
            } catch (err) {
                if (err instanceof Error) {
                    vscode.window.showErrorMessage(`Failed to read private key: ${err.message}`);
                } else {
                    vscode.window.showErrorMessage('Failed to read private key due to an unknown error.');
                }
                this.removeConnectionFromList(connection);
                return;
            }
    
            if (!passphrase) {
                vscode.window.showErrorMessage('No passphrase provided for the private key.');
                return;
            }
    
            connection.client = new Client();
    
            connection.client.on('error', (err) => {
                vscode.window.showErrorMessage(`Failed to connect: ${err.message}`);
                console.error(`Failed to connect: ${err.message}`);
                this.removeConnectionFromList(connection);
            });
    
            await this.handleConnectionReady(connection, treeItem, `sshpass -P "Enter passphrase for key '${identityFile}':" -p ${passphrase} ssh -i ${identityFile} ${connection.user}@${connection.hostname} -p ${connection.port}`);
    
            connection.client.connect({
                host: connection.host,
                port: connection.port ?? SSH_DEFAULT_PORT,
                username: connection.user,
                privateKey: Buffer.from(fileUtils.readFile(identityFile)),
                passphrase: passphrase // Use the passphrase if provided
            });
    
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error connecting with SSH key: ${error.message}`);
        }
    }

    private async isSSHPassInstalled(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            const { exec } = require('child_process');
            exec('command -v sshpass', (error: Error | null, stdout: string, stderr: string) => {
                if (error) {
                    console.error(`Error checking for sshpass: ${stderr}`);
                    reject(new Error("sshpass not found"));
                } else {
                    resolve(stdout.trim().length > 0);
                }
            });
        });
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
            const remoteFileViewTitle = new RemoteFileViewTitle(`Connection: ${connection.user}@${connection.host}`);
            remoteFileProvider.setTitleItem(remoteFileViewTitle);
            vscode.window.registerTreeDataProvider('remoteFilesView', remoteFileProvider);
        } else {
            remoteFileProvider.updateConnection(connection, remotePath);
        }
    
        remoteFileProvider.refresh();
        vscode.commands.executeCommand('setContext', 'sshConnectionActive', true);
    }

    public getRemoteFileProvider(connectionId: string): RemoteFileProvider | undefined {
        return this.remoteFileProviders.get(connectionId);
    }

    public refresh(): void {
        this._onDidChangeTreeData.fire();
    }
}

export class SSHConnectionTreeItem extends vscode.TreeItem {
    constructor(public readonly connection: ExtendedSSHConnection, public connected: boolean) {
        const label = connection.user ? `${connection.user}@${connection.host}` : connection.host || 'Unknown Host';
        super(label, vscode.TreeItemCollapsibleState.None);

        this.tooltip = connection.user
            ? `${connection.user}@${connection.host}`
            : connection.host || 'Unknown Host';
        this.description = connection.user
            ? `${connection.user}@${connection.host}`
            : connection.host || 'Unknown Host';
        this.contextValue = 'sshConnection';

        this.updateContextValue();
    }

    updateContextValue() {
        this.contextValue = this.connected ? 'sshConnectionConnected' : 'sshConnectionDisconnected';
    }
}

export class SSHFolderTreeItem extends vscode.TreeItem {
    constructor(public readonly folderName: string) {
        super(folderName.split('/').pop()!, vscode.TreeItemCollapsibleState.Collapsed);
        this.tooltip = `Folder: ${folderName}`;
        this.description = folderName;
        this.contextValue = 'sshFolder';
    }
}