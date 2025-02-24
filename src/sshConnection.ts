import * as vscode from 'vscode';
import * as path from 'path';
import * as fileUtils from './utils/fileUtils';
import { spawn } from 'child_process';
import { Client, utils } from 'ssh2';
import { RemoteFileProvider, RemoteFileViewTitle, EmptyRemoteFileProvider } from './remoteFile';
import { SSH_CONFIG_DIR, SSH_CONFIG_PATH, SSH_KNOWN_HOSTS_PATH, SSH_DEFAULT_PORT } from './constants/sshConstants';

// SSHConnection Interface
export interface SSHConnection {
    id: string;
    host: string;
    username: string;
    port?: string;
    client?: Client;
    usePrivateKey?: boolean;
    password?: string;
    privateKeyPath?: string;
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

        const username = await vscode.window.showInputBox({ placeHolder: 'Username' });
        if (!username) {
            vscode.window.showErrorMessage('Username is required.');
            return;
        }

        const port = await vscode.window.showInputBox({ placeHolder: `Port (default ${SSH_DEFAULT_PORT})`, value: SSH_DEFAULT_PORT.toString() });
        const usePrivateKey = await vscode.window.showQuickPick(['Yes', 'No'], {
            placeHolder: 'Use SSH Key?'
        });
        if (!usePrivateKey) {
            vscode.window.showErrorMessage('SSH Key usage selection is required.');
            return;
        }

        let privateKeyPath = '';
        if (usePrivateKey === 'Yes') {
            const destinationPrivateKeyPath = path.join(SSH_CONFIG_DIR, `${username}_${host}_key`);

            fileUtils.ensureDirectoryExists(SSH_CONFIG_DIR, 0o700);

            if (fileUtils.fileExists(destinationPrivateKeyPath)) {
                const document = await vscode.workspace.openTextDocument(destinationPrivateKeyPath);
                await vscode.window.showTextDocument(document);
            } else {
                fileUtils.writeFile(destinationPrivateKeyPath, '', 0o600);

                const document = await vscode.workspace.openTextDocument(destinationPrivateKeyPath);
                await vscode.window.showTextDocument(document);
            }

            // Show the warning message and wait for the user to confirm they have pasted the key
            await vscode.window.showWarningMessage('Paste your SSH private key into the opened file and save it, then click Done.', 'Done');

            // Wait for the user to press Done and for the editor to no longer be dirty
            await new Promise<void>(resolve => {
                const interval = setInterval(async () => {
                    const editorContent = await vscode.workspace.openTextDocument(destinationPrivateKeyPath);
                    if (!editorContent.isDirty) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 1000);
            });

            const privateKeyContent = fileUtils.readFile(destinationPrivateKeyPath);
            if (!privateKeyContent) {
                vscode.window.showErrorMessage('SSH Private Key is required.');
                return;
            }

            // Close the editor
            await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            privateKeyPath = destinationPrivateKeyPath;
        }

        fileUtils.ensureDirectoryExists(SSH_CONFIG_DIR, 0o700);

        if (!fileUtils.fileExists(SSH_CONFIG_PATH)) {
            fileUtils.writeFile(SSH_CONFIG_PATH, '', 0o600);
        }

        const existingConnection = sshViewProvider.connections.find((conn: SSHConnection) => conn.host === host && conn.username === username);
        if (existingConnection) {
            vscode.window.showInformationMessage(`Connection to ${host} as ${username} already exists.`);
            return;
        }

        const newConnection = `Host ${host}\n    HostName ${host}\n    User ${username}\n    Port ${port ?? SSH_DEFAULT_PORT}\n`;
        fileUtils.appendToFile(SSH_CONFIG_PATH, newConnection + (usePrivateKey === 'Yes' ? `    IdentityFile ${privateKeyPath}\n` : '') + '\n');

        sshViewProvider.loadSSHConnections();

        sshViewProvider.connections.push({
            id: host,
            host,
            username,
            port: port ?? SSH_DEFAULT_PORT.toString(),
            usePrivateKey: usePrivateKey === 'Yes',
            privateKeyPath: usePrivateKey === 'Yes' ? privateKeyPath : undefined
        });

        const uniqueConnections = sshViewProvider.connections.filter((conn, index, self) =>
            index === self.findIndex((c) => (
                c.host === conn.host && c.username === conn.username
            ))
        );

        sshViewProvider.connections = uniqueConnections;
        sshViewProvider.refresh();

    } catch (error: any) {
        vscode.window.showErrorMessage(`Error adding SSH connection: ${error.message}`);
    }
}

// Function to check and manage host fingerprints
async function checkAndUpdateKnownHosts(connection: SSHConnection): Promise<void> {
    return new Promise((resolve, reject) => {
        const { host } = connection;

        fileUtils.readFileAsync(SSH_KNOWN_HOSTS_PATH).then(data => {
            const knownHostsLines = data ? data.split('\n') : [];
            const hostPattern = new RegExp(`^${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[\\s,].*)?$`, 'm');
            const isHostKnown = knownHostsLines.some(line => hostPattern.test(line));

            if (isHostKnown) {
                resolve();
                return;
            }

            // Use ssh-keyscan to fetch the host key and add it to known_hosts
            const keyscan = spawn('ssh-keyscan', ['-H', host]);

            keyscan.stdout.on('data', (data: Buffer) => {
                fileUtils.appendFileAsync(SSH_KNOWN_HOSTS_PATH, data.toString()).then(() => {
                    resolve();
                }).catch(err => {
                    reject(new Error(`Error appending to known_hosts file: ${err.message}`));
                });
            });

            keyscan.stderr.on('data', (data: Buffer) => {
                console.error(`ssh-keyscan error: ${data.toString()}`);
            });

            keyscan.on('error', (error: Error) => {
                reject(new Error(`ssh-keyscan failed: ${error.message}`));
            });

            keyscan.on('close', (code: number) => {
                if (code !== 0) {
                    reject(new Error(`ssh-keyscan exited with code ${code}`));
                }
            });
        }).catch(err => {
            if (err.code !== 'ENOENT') {
                reject(new Error(`Error reading known_hosts file: ${err.message}`));
            } else {
                resolve();
            }
        });
    });
}

// Main class for managing SSH connections
export class SSHViewProvider implements vscode.TreeDataProvider<SSHConnectionTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<SSHConnectionTreeItem | undefined | void> = new vscode.EventEmitter<SSHConnectionTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<SSHConnectionTreeItem | undefined | void> = this._onDidChangeTreeData.event;

    public connections: SSHConnection[] = [];
    private selectedConnection?: SSHConnection;
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

    getChildren(element?: SSHConnectionTreeItem): Thenable<SSHConnectionTreeItem[]> {
        if (!element) {
            return Promise.resolve(this.connections.map(conn => new SSHConnectionTreeItem(conn, !!conn.client)));
        }
        return Promise.resolve([]);
    }

    loadSSHConnections() {
        if (fileUtils.fileExists(SSH_CONFIG_PATH)) {
            const configFile = fileUtils.readFile(SSH_CONFIG_PATH);
            const configLines = configFile.split('\n');
            let currentHost: SSHConnection | null = null;
            this.connections = [];

            configLines.forEach(line => {
                const trimmedLine = line.trim();
                if (trimmedLine.startsWith('Host ')) {
                    if (currentHost) {
                        this.connections.push(currentHost);
                    }
                    const host = trimmedLine.substring(5).trim();
                    currentHost = { id: host, host, username: '', port: SSH_DEFAULT_PORT.toString() };
                } else if (currentHost) {
                    if (trimmedLine.startsWith('User ')) {
                        currentHost.username = trimmedLine.substring(5).trim();
                    } else if (trimmedLine.startsWith('Port ')) {
                        currentHost.port = trimmedLine.substring(5).trim();
                    } else if (trimmedLine.startsWith('IdentityFile ')) {
                        currentHost.usePrivateKey = true;
                        currentHost.privateKeyPath = trimmedLine.substring(13).trim();
                    }
                }
            });

            if (currentHost) {
                this.connections.push(currentHost);
            }

            this._onDidChangeTreeData.fire();
        }
    }

    // Connection selection
    public selectConnection(treeItem: SSHConnectionTreeItem) {
        const connection = treeItem.connection;
        const terminal = this.terminals.get(connection.id);
    
        if (connection.client) {
            this.selectedConnection = connection;
    
            // Check if a remoteFileProvider already exists for the connection
            let remoteFileProvider = this.remoteFileProviders.get(connection.id);
            if (!remoteFileProvider) {
                remoteFileProvider = new RemoteFileProvider(connection, '/');
                this.remoteFileProviders.set(connection.id, remoteFileProvider);
            }
            vscode.window.registerTreeDataProvider('remoteFilesView', remoteFileProvider);
    
            // Set the title item to indicate the related connection
            const titleItem = new RemoteFileViewTitle(`Connected to ${connection.host}`);
            remoteFileProvider.setTitleItem(titleItem);
        } else {
            vscode.window.showErrorMessage(`Connection to ${connection.host} is not active. Please reconnect.`);
            this.selectedConnection = undefined;
            const emptyProvider = new EmptyRemoteFileProvider();
            const emptyTitleItem = new RemoteFileViewTitle('No Active Connection');
            emptyProvider.setTitleItem(emptyTitleItem);
            vscode.window.registerTreeDataProvider('remoteFilesView', emptyProvider);
        }
    
        if (terminal) {
            terminal.show();
        } else {
            vscode.window.showErrorMessage(`No terminal found for connection ${connection.username}@${connection.host}`);
        }
    
        vscode.commands.executeCommand('setContext', 'sshConnectionActive', !!this.selectedConnection);
    
        // Ensure the remote file view is refreshed and displayed
        if (this.selectedConnection) {
            this.loadRemoteFiles(this.selectedConnection, '/');
        }
    }

    // Method to register a terminal for an SSH connection
    public registerTerminal(connection: SSHConnection, terminal: vscode.Terminal) {
        this.terminals.set(connection.id, terminal);
    }

    removeConnection(treeItem: SSHConnectionTreeItem) {
        const connection = treeItem.connection;

        if (!connection.host || !connection.username) {
            vscode.window.showErrorMessage('Host and Username are required. Cannot remove connection.');
            return;
        }
        console.log('Removing connection for host:', connection.host, 'and user:', connection.username);

        let configFile = fileUtils.readFile(SSH_CONFIG_PATH);

        const configLines = configFile.split('\n');
        let insideHostBlock = false;
        let blockStartIndex = -1;
        let blockEndIndex = -1;
        let foundUser = false;

        for (let i = 0; i < configLines.length; i++) {
            const line = configLines[i];

            if (/^Host\s/.test(line)) {
                // If we're inside a block and it matches the criteria, remove it
                if (insideHostBlock && foundUser) {
                    configLines.splice(blockStartIndex, blockEndIndex - blockStartIndex + 1);
                    break;
                }
                // Start a new block
                insideHostBlock = true;
                blockStartIndex = i;
                blockEndIndex = i;
                foundUser = false;
            } else if (insideHostBlock) {
                blockEndIndex = i;
                if (/^\s*User\s+/.test(line)) {
                    const currentUsername = line.split(/\s+/)[2];
                    if (currentUsername === connection.username) {
                        foundUser = true;
                    }
                }
            }

            // If we've reached the last line of the file, check the final block
            if (i === configLines.length - 1 && insideHostBlock && foundUser) {
                configLines.splice(blockStartIndex, blockEndIndex - blockStartIndex + 1);
            }
        }

        const updatedConfigFile = configLines.join('\n');

        fileUtils.writeFile(SSH_CONFIG_PATH, updatedConfigFile + '\n'.trimStart(), 0o600);

        const finalConfigFile = fileUtils.readFile(SSH_CONFIG_PATH);
        console.log('Updated config file:\n', finalConfigFile);

        this.connections = this.connections.filter(conn => !(conn.host === connection.host && conn.username === connection.username));

        this._onDidChangeTreeData.fire();
        console.log('Connection removed from file and list:', connection);

        const terminalName = `${connection.username}@${connection.host}`;
        vscode.window.terminals.forEach(terminal => {
            if (terminal.name === terminalName) {
                terminal.dispose();
            }
        });

        if (this.selectedConnection && this.selectedConnection.host === connection.host && this.selectedConnection.username === connection.username) {
            vscode.commands.executeCommand('setContext', 'sshConnectionActive', false);
            const remoteFileProvider = new EmptyRemoteFileProvider();
            vscode.window.registerTreeDataProvider('remoteFilesView', remoteFileProvider);
            this.selectedConnection = undefined;
        }
    }

    // Connection and disconnection functions
    connect(treeItem: SSHConnectionTreeItem) {
        const connection = treeItem.connection;
        if (!connection.client) {
            connection.client = new Client();
        }

        checkAndUpdateKnownHosts(connection).then(() => {
            if (connection.usePrivateKey) {
                const privateKeyPath = connection.privateKeyPath ?? path.join(SSH_CONFIG_DIR, `${connection.username}_${connection.host}_key`);
                if (fileUtils.fileExists(privateKeyPath)) {
                    connection.privateKeyPath = privateKeyPath;
                    this.connectWithSSHKey(connection, treeItem);
                } else {
                    vscode.window.showErrorMessage(`Private key file not found: ${privateKeyPath}`);
                }
            } else {
                vscode.window.showInputBox({ placeHolder: 'Password', password: true }).then(password => {
                    if (password) {
                        connection.password = password;
                        this.connectWithPassword(connection, treeItem, password);
                    } else {
                        vscode.window.showErrorMessage('Connection cancelled. No password provided.');
                    }
                });
            }
        }).catch(error => {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            vscode.window.showErrorMessage(`Error during known hosts verification: ${errorMessage}`);
        });
    }

    disconnect(treeItem: SSHConnectionTreeItem) {
        const connection = treeItem.connection;
        if (connection.client) {
            connection.client.end();
            vscode.window.showInformationMessage(`Disconnected from ${connection.host}`);
            connection.client = undefined;
            treeItem.connected = false;
            treeItem.updateContextValue();
            this._onDidChangeTreeData.fire(treeItem);

            const terminalName = `${connection.username}@${connection.host}`;
            vscode.window.terminals.forEach(terminal => {
                if (terminal.name === terminalName) {
                    terminal.dispose();
                }
            });

            // Cleanup the remote file provider
            const remoteFileProvider = this.remoteFileProviders.get(connection.id);
            if (remoteFileProvider) {
                remoteFileProvider.cleanup();
                this.remoteFileProviders.delete(connection.id);
            }

            // Close the remote file view associated with the disconnected connection
            const emptyProvider = new EmptyRemoteFileProvider();
            vscode.window.registerTreeDataProvider('remoteFilesView', emptyProvider);

            if (this.selectedConnection && this.selectedConnection.id === connection.id) {
                this.selectedConnection = undefined;
                vscode.commands.executeCommand('setContext', 'sshConnectionActive', false);
            }

            // Update the tree item context to reflect the disconnected state
            treeItem.updateContextValue();
            this._onDidChangeTreeData.fire(treeItem);
        } else {
            vscode.window.showInformationMessage(`Not connected to ${connection.host}`);
        }
    }

    // Method to handle connection ready event
    private async handleConnectionReady(connection: SSHConnection, treeItem: SSHConnectionTreeItem, terminalArgs: string) {
        connection.client!.on('ready', async () => {
            console.log("Connection ready");
            vscode.window.showInformationMessage(`Connected to ${connection.host}`);
    
            treeItem.connected = true;
            treeItem.updateContextValue();
            this._onDidChangeTreeData.fire(treeItem);
    
            // Use the existing SSH connection to open the terminal
            const terminalName = `${connection.username}@${connection.host}`;
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
        const connection = this.connections.find(conn => `${conn.username}@${conn.host}` === terminal.name);
        if (connection) {
            const treeItem = new SSHConnectionTreeItem(connection, !!connection.client);
            this.selectConnection(treeItem);
            this._onDidChangeTreeData.fire(treeItem);
        }
    }

    // Method to handle terminal close event
    public handleTerminalClose(terminal: vscode.Terminal) {
        const connectionIndex = this.connections.findIndex(conn => `${conn.username}@${conn.host}` === terminal.name);
        if (connectionIndex !== -1) {
            const connection = this.connections[connectionIndex];
            const treeItem = new SSHConnectionTreeItem(connection, false);
            this.disconnect(treeItem);
            this._onDidChangeTreeData.fire(); // Refresh the view
        }
    }

    // Method to handle remote file view selection change
    public handleRemoteFileSelectionChange(resourceUri: vscode.Uri) {
        const connection = this.connections.find(conn => resourceUri.authority === `${conn.username}@${conn.host}:${conn.port}`);
        if (connection) {
            const treeItem = new SSHConnectionTreeItem(connection, !!connection.client);
            this.selectConnection(treeItem);
            this._onDidChangeTreeData.fire(treeItem);
        }
    }

    private async connectWithPassword(connection: SSHConnection, treeItem: SSHConnectionTreeItem, password: string) {
        try {
            const installed = await this.isSSHPassInstalled();
            if (!installed) {
                vscode.window.showErrorMessage(`'sshpass' is not installed locally. Please install it to proceed.`);
                return;
            }
    
            connection.client!.on('error', (err) => {
                vscode.window.showErrorMessage(`Failed to connect: ${err.message}`);
                console.error(`Failed to connect: ${err.message}`);
            });
    
            await this.handleConnectionReady(connection, treeItem, `sshpass -p ${password} ssh ${connection.username}@${connection.host} -p ${connection.port}`);
    
            connection.client!.connect({
                host: connection.host,
                username: connection.username,
                password: password,
                port: parseInt(connection.port ?? SSH_DEFAULT_PORT.toString())
            });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error connecting with password: ${error.message}`);
        }
    }

    private async connectWithSSHKey(connection: SSHConnection, treeItem: SSHConnectionTreeItem) {
        try {
            const installed = await this.isSSHPassInstalled();
            if (!installed) {
                vscode.window.showErrorMessage(`'sshpass' is not installed locally. Please install it to proceed.`);
                return;
            }
    
            const privateKeyPath = connection.privateKeyPath!;
            let passphrase: string | undefined = connection.passphrase;
    
            try {
                const privateKey = fileUtils.readFile(privateKeyPath);
                const parsedKey = utils.parseKey(Buffer.from(privateKey));
    
                if (parsedKey instanceof Error && parsedKey.message.toLowerCase().includes('encrypted')) {
                    // The private key is protected by a passphrase
                    passphrase = await vscode.window.showInputBox({ placeHolder: 'Passphrase for private key', password: true });
                    if (!passphrase) {
                        vscode.window.showErrorMessage('Passphrase not provided. Connection cancelled.');
                        return;
                    }
                }
            } catch (err) {
                if (err instanceof Error) {
                    vscode.window.showErrorMessage(`Failed to read private key: ${err.message}`);
                } else {
                    vscode.window.showErrorMessage('Failed to read private key due to an unknown error.');
                }
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
            });
    
            await this.handleConnectionReady(connection, treeItem, `sshpass -P "Enter passphrase for key '${privateKeyPath}':" -p ${passphrase} ssh -i ${privateKeyPath} ${connection.username}@${connection.host} -p ${connection.port}`);
    
            connection.client.connect({
                host: connection.host,
                port: parseInt(connection.port ?? SSH_DEFAULT_PORT.toString()),
                username: connection.username,
                privateKey: Buffer.from(fileUtils.readFile(privateKeyPath)),
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

    private async loadRemoteFiles(connection: SSHConnection, remotePath: string) {
        if (!connection.client) {
            vscode.window.showErrorMessage('SSH connection is not established.');
            return;
        }

        let remoteFileProvider = this.remoteFileProviders.get(connection.id);
        if (!remoteFileProvider) {
            remoteFileProvider = new RemoteFileProvider(connection, remotePath);
            const remoteFileViewTitle = new RemoteFileViewTitle(`Connection: ${connection.username}@${connection.host}`);
            remoteFileProvider.setTitleItem(remoteFileViewTitle);
            vscode.window.registerTreeDataProvider('remoteFilesView', remoteFileProvider);
            this.remoteFileProviders.set(connection.id, remoteFileProvider);
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
    constructor(public readonly connection: SSHConnection, public connected: boolean) {
        super(`${connection.username}@${connection.host}`, vscode.TreeItemCollapsibleState.None);
        this.tooltip = `${this.connection.username}@${this.connection.host}`;
        this.description = this.connection.host;
        this.contextValue = 'sshConnection';
    
        this.updateContextValue();
    }

    updateContextValue() {
        this.contextValue = this.connected ? 'sshConnectionConnected' : 'sshConnectionDisconnected';
    }
}