import * as vscode from 'vscode';
import { setExtensionContext } from './constants/globals';
import * as fileUtils from './utils/fileUtils';
import { 
    SSHViewProvider, 
    SSHConnectionTreeItem, 
    SSHFolderTreeItem, 
    addSSHConnection, 
    MultiCommandPanel 
} from './sshConnection';
import { EmptyRemoteFileProvider } from './remoteFile';
import { SSH_CONFIG_PATH, checkAndInstallSshpass } from './utils/sshUtils';

export function activate(context: vscode.ExtensionContext) {
    setExtensionContext(context);
    checkAndInstallSshpass();

    const sshViewProvider = new SSHViewProvider(context);
    const sshTreeView = createSSHTreeView(context, sshViewProvider);

    registerEventListeners(context, sshViewProvider, sshTreeView);
    registerCommands(context, sshViewProvider);
    monitorSSHConfigFile(context, sshViewProvider);

    registerTreeAndWebviewProviders(context, sshViewProvider);
}

function createSSHTreeView(
    context: vscode.ExtensionContext, 
    sshViewProvider: SSHViewProvider
): vscode.TreeView<SSHConnectionTreeItem | SSHFolderTreeItem> {
    const sshTreeView = vscode.window.createTreeView('sshConnectionsView', {
        treeDataProvider: sshViewProvider
    });

    context.subscriptions.push(
        sshTreeView.onDidChangeSelection(event => handleTreeViewSelection(event, sshViewProvider))
    );

    return sshTreeView;
}

function handleTreeViewSelection(
    event: vscode.TreeViewSelectionChangeEvent<SSHConnectionTreeItem | SSHFolderTreeItem>, 
    sshViewProvider: SSHViewProvider
) {
    const selectedItem = event.selection[0];
    if (selectedItem instanceof SSHConnectionTreeItem) {
        sshViewProvider.selectConnection(selectedItem);
    }
}

function registerEventListeners(
    context: vscode.ExtensionContext, 
    sshViewProvider: SSHViewProvider, 
    sshTreeView: vscode.TreeView<SSHConnectionTreeItem | SSHFolderTreeItem>
) {
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTerminal(terminal => {
            if (terminal) {
                sshViewProvider.handleTerminalSelectionChange(terminal);
            }
        }),
        vscode.window.onDidCloseTerminal(terminal => sshViewProvider.handleTerminalClose(terminal)),
        vscode.window.onDidChangeVisibleTextEditors(editors => handleVisibleTextEditorsChange(editors, sshViewProvider))
    );
}

function handleVisibleTextEditorsChange(
    editors: readonly vscode.TextEditor[], 
    sshViewProvider: SSHViewProvider
) {
    const activeEditor = editors.find(editor => editor.document.uri.scheme === 'ssh');
    if (activeEditor) {
        sshViewProvider.handleRemoteFileSelectionChange(activeEditor.document.uri);
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
        { command: 'sshMultiConnect.refreshRemoteFiles', callback: () => refreshRemoteFiles(sshViewProvider) },
        { command: 'sshMultiConnect.openMultiCommandPanel', callback: () => sshViewProvider.openMultiCommandPanel() }
    ];

    commands.forEach(({ command, callback }) => {
        context.subscriptions.push(vscode.commands.registerCommand(command, callback));
    });
}

async function openRemoteFile(
    resourceUri: vscode.Uri, 
    treeItem: SSHConnectionTreeItem, 
    sshViewProvider: SSHViewProvider
) {
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
    remoteFileProvider?.refresh() ?? vscode.window.showErrorMessage('No remote file provider found.');
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

function registerTreeAndWebviewProviders(context: vscode.ExtensionContext, sshViewProvider: SSHViewProvider) {
    vscode.window.registerTreeDataProvider('remoteFilesView', new EmptyRemoteFileProvider());
    vscode.window.registerWebviewViewProvider('multiCommandView', {
        resolveWebviewView: (webviewView) => {
            const connectedConnections = sshViewProvider.connections.filter(conn => conn.client) || [];
            const multiCommandPanel = new MultiCommandPanel(webviewView, connectedConnections);

            sshViewProvider.setMultiCommandPanel(multiCommandPanel);
            sshViewProvider.refresh();
        }
    });
}

export function deactivate() {
    console.log('Cleaning up resources...');
    vscode.window.terminals
        .filter(terminal => terminal.name.startsWith('SSH:'))
        .forEach(terminal => terminal.dispose());

    vscode.workspace.textDocuments
        .filter(document => ['ssh', 'vscode-remote'].includes(document.uri.scheme))
        .forEach(document => vscode.commands.executeCommand('workbench.action.closeActiveEditor'));
}