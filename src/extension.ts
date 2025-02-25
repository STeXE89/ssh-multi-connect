import * as vscode from 'vscode';
import * as fileUtils from './utils/fileUtils';
import { SSHViewProvider, SSHConnectionTreeItem, addSSHConnection } from './sshConnection';
import { EmptyRemoteFileProvider } from './remoteFile';
import { SSH_CONFIG_PATH } from './constants/sshConstants';
import { checkAndInstallSshpass } from './utils/sshUtils';

export function activate(context: vscode.ExtensionContext) {
    checkAndInstallSshpass();

    const sshViewProvider = new SSHViewProvider(context);
    const sshTreeView = vscode.window.createTreeView('sshConnectionsView', {
        treeDataProvider: sshViewProvider
    });

    // Add event listener for SSH connection selection change
    const sshTreeViewSelectionListener = sshTreeView.onDidChangeSelection(event => {
        if (event.selection.length > 0 && event.selection[0] instanceof SSHConnectionTreeItem) {
            sshViewProvider.selectConnection(event.selection[0]);
        }
    });

    context.subscriptions.push(sshTreeViewSelectionListener);

    // Add event listener for terminal selection change
    vscode.window.onDidChangeActiveTerminal(terminal => {
        if (terminal) {
            sshViewProvider.handleTerminalSelectionChange(terminal);
        }
    });

    vscode.window.onDidCloseTerminal(terminal => {
        sshViewProvider.handleTerminalClose(terminal);
    });

    // Add event listener for remote file view selection change
    vscode.window.onDidChangeVisibleTextEditors(editors => {
        const activeEditor = editors.find(editor => editor.document.uri.scheme === 'ssh');
        if (activeEditor) {
            sshViewProvider.handleRemoteFileSelectionChange(activeEditor.document.uri);
        }
    });

    registerCommands(context, sshViewProvider);
    monitorSSHConfigFile(context, sshViewProvider);

    vscode.window.registerTreeDataProvider('remoteFilesView', new EmptyRemoteFileProvider());
}

function registerCommands(context: vscode.ExtensionContext, sshViewProvider: SSHViewProvider) {
    const commands = [
        { command: 'sshMultiConnect.addConnection', callback: () => addSSHConnection(sshViewProvider) },
        { command: 'sshMultiConnect.connect', callback: (treeItem: SSHConnectionTreeItem) => sshViewProvider.connect(treeItem) },
        { command: 'sshMultiConnect.disconnect', callback: (treeItem: SSHConnectionTreeItem) => sshViewProvider.disconnect(treeItem) },
        { command: 'sshMultiConnect.removeConnection', callback: (treeItem: SSHConnectionTreeItem) => sshViewProvider.removeConnection(treeItem) },
        { command: 'sshMultiConnect.openRemoteFile', callback: async (resourceUri: vscode.Uri, treeItem: SSHConnectionTreeItem) => {
            if (treeItem.id) {
                const remoteFileProvider = sshViewProvider.getRemoteFileProvider(treeItem.id);
                if (remoteFileProvider) {
                    await remoteFileProvider.openRemoteFile(resourceUri);
                } else {
                    vscode.window.showErrorMessage('No connection selected.');
                }
            } else {
                vscode.window.showErrorMessage('Invalid connection ID.');
            }
        }},
        { command: 'sshMultiConnect.refreshRemoteFiles', callback: () => {
            const sshConnection = sshViewProvider.getSelectedConnection();
            if (sshConnection) {
                const remoteFileProvider = sshViewProvider.getRemoteFileProvider(sshConnection.id);
                if (remoteFileProvider) {
                    remoteFileProvider.refresh();
                } else {
                    vscode.window.showErrorMessage('No remote file provider found.');
                }
            } else {
                vscode.window.showErrorMessage('No active connection selected.');
            }
        }}
    ];

    commands.forEach(({ command, callback }) => {
        context.subscriptions.push(vscode.commands.registerCommand(command, callback));
    });
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
    // Close all related terminals and remote file views
    vscode.window.terminals.forEach(terminal => terminal.dispose());
    vscode.workspace.textDocuments.forEach(document => {
        if (document.uri.scheme === 'vscode-remote') {
            vscode.window.showTextDocument(document).then(editor => {
                vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            });
        }
    });
}