import * as vscode from 'vscode';
import * as fileUtils from './utils/fileUtils';
import { SSHViewProvider, SSHConnectionTreeItem, SSHFolderTreeItem, addSSHConnection } from './sshConnection';
import { EmptyRemoteFileProvider } from './remoteFile';
import { SSH_CONFIG_PATH, checkAndInstallSshpass } from './utils/sshUtils';

let sshViewProvider: SSHViewProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
    checkAndInstallSshpass();

    sshViewProvider = new SSHViewProvider(context);
    const sshTreeView = createSSHTreeView(context, sshViewProvider);

    registerEventListeners(context, sshViewProvider, sshTreeView);
    registerCommands(context, sshViewProvider);
    monitorSSHConfigFile(context, sshViewProvider);

    vscode.window.registerTreeDataProvider('remoteFilesView', new EmptyRemoteFileProvider());
}

function createSSHTreeView(context: vscode.ExtensionContext, sshViewProvider: SSHViewProvider): vscode.TreeView<SSHConnectionTreeItem | SSHFolderTreeItem> {
    const sshTreeView = vscode.window.createTreeView('sshConnectionsView', {
        treeDataProvider: sshViewProvider
    });

    const sshTreeViewSelectionListener = sshTreeView.onDidChangeSelection(event => {
        const selectedItem = event.selection[0];
        if (selectedItem instanceof SSHConnectionTreeItem) {
            sshViewProvider.selectConnection(selectedItem);
        }
    });

    context.subscriptions.push(sshTreeViewSelectionListener);
    return sshTreeView;
}

function registerEventListeners(context: vscode.ExtensionContext, sshViewProvider: SSHViewProvider, sshTreeView: vscode.TreeView<SSHConnectionTreeItem | SSHFolderTreeItem>) {
    vscode.window.onDidChangeActiveTerminal(terminal => handleTerminalSelectionChange(terminal, sshViewProvider));
    vscode.window.onDidCloseTerminal(terminal => sshViewProvider.handleTerminalClose(terminal));

    vscode.window.onDidChangeVisibleTextEditors(editors => {
        const activeEditor = editors.find(editor => editor.document.uri.scheme === 'ssh');
        if (activeEditor) {
            sshViewProvider.handleRemoteFileSelectionChange(activeEditor.document.uri);
        }
    });
}

function handleTerminalSelectionChange(terminal: vscode.Terminal | undefined, sshViewProvider: SSHViewProvider) {
    if (terminal) {
        sshViewProvider.handleTerminalSelectionChange(terminal);
    }
}

function registerCommands(context: vscode.ExtensionContext, sshViewProvider: SSHViewProvider) {
    const commands = [
        { command: 'sshMultiConnect.addConnection', callback: () => addSSHConnection(sshViewProvider) },
        { command: 'sshMultiConnect.connect', callback: (treeItem: SSHConnectionTreeItem) => sshViewProvider.connect(treeItem) },
        { command: 'sshMultiConnect.disconnect', callback: (treeItem: SSHConnectionTreeItem) => sshViewProvider.disconnect(treeItem) },
        { command: 'sshMultiConnect.removeConnection', callback: (treeItem: SSHConnectionTreeItem) => sshViewProvider.removeConnection(treeItem) },
        { command: 'sshMultiConnect.moveToFolder', callback: (treeItem: SSHConnectionTreeItem) => sshViewProvider.moveConnectionToFolder(treeItem) },
        { command: 'sshMultiConnect.openRemoteFile', callback: async (resourceUri: vscode.Uri, treeItem: SSHConnectionTreeItem) => openRemoteFile(resourceUri, treeItem, sshViewProvider) },
        { command: 'sshMultiConnect.refreshRemoteFiles', callback: () => refreshRemoteFiles(sshViewProvider) }
    ];

    commands.forEach(({ command, callback }) => {
        context.subscriptions.push(vscode.commands.registerCommand(command, callback));
    });
}

async function openRemoteFile(resourceUri: vscode.Uri, treeItem: SSHConnectionTreeItem, sshViewProvider: SSHViewProvider) {
    if (!treeItem.id) {
        vscode.window.showErrorMessage('Invalid connection ID.');
        return;
    }

    const remoteFileProvider = sshViewProvider.getRemoteFileProvider(treeItem.id);
    if (remoteFileProvider) {
        await remoteFileProvider.openRemoteFile(resourceUri);
    } else {
        vscode.window.showErrorMessage('No connection selected.');
    }
}

function refreshRemoteFiles(sshViewProvider: SSHViewProvider) {
    const sshConnection = sshViewProvider.getSelectedConnection();
    if (!sshConnection) {
        vscode.window.showErrorMessage('No active connection selected.');
        return;
    }

    const remoteFileProvider = sshViewProvider.getRemoteFileProvider(sshConnection.id);
    if (remoteFileProvider) {
        remoteFileProvider.refresh();
    } else {
        vscode.window.showErrorMessage('No remote file provider found.');
    }
}

async function monitorSSHConfigFile(context: vscode.ExtensionContext, sshViewProvider: SSHViewProvider) {
    try {
        await fileUtils.readFileAsync(SSH_CONFIG_PATH); // Check if file exists
        const watcher = fileUtils.watchFile(SSH_CONFIG_PATH, eventType => {
            if (eventType === 'change') {
                sshViewProvider.loadSSHConnections();
            }
        });
        context.subscriptions.push(new vscode.Disposable(() => watcher.close()));
    } catch (error) {
        console.error(`File ${SSH_CONFIG_PATH} does not exist.`);
    }
}

export function deactivate() {
    if (!sshViewProvider) {
        return;
    }

    closeAllTerminals();
    closeAllRemoteFileViews();
    disconnectAllConnections(sshViewProvider);

    console.log('All active connections, terminals, and remote files have been cleaned up.');
}

function closeAllTerminals() {
    vscode.window.terminals.forEach(terminal => {
        if (terminal.name.startsWith('SSH:')) {
            terminal.dispose();
        }
    });
}

function closeAllRemoteFileViews() {
    vscode.workspace.textDocuments.forEach(document => {
        if (document.uri.scheme === 'ssh' || document.uri.scheme === 'vscode-remote') {
            vscode.window.showTextDocument(document).then(() => {
                vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            });
        }
    });
}

function disconnectAllConnections(sshViewProvider: SSHViewProvider) {
    sshViewProvider.connections.forEach(connection => {
        if (connection.client) {
            const treeItem = new SSHConnectionTreeItem(connection, true);
            sshViewProvider.disconnect(treeItem);
        }
    });
}