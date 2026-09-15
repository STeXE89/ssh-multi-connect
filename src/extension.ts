import * as vscode from 'vscode';
import { setExtensionContext } from './constants/globals';
import * as fileUtils from './utils/fileUtils';
import {
    SSHViewProvider,
    SSHConnectionTreeItem,
    SSHTreeNode,
    activeConnectionBadge,
    ExtendedSSHConnection,
    addSSHConnection,
    MultiCommandPanel,
} from './sshConnection';
import { EmptyRemoteFileProvider, RemoteFileProvider, RemoteFileTreeItem } from './remoteFile';
import { SSH_CONFIG_PATH, checkSshTooling } from './utils/sshUtils';
import { RemoteFilesView } from './remoteFilesView';
import { SSHTreeDecorationProvider } from './connectionDecorations';
import { countInFolder } from './utils/folders';
import { TerminalPathFollower } from './terminalFollow';
import { TunnelManager } from './tunnels';
import { CredentialStore } from './credentials';
import { RemoteFilesDropController } from './remoteDropController';
import { CommandResultsDocuments, RESULTS_SCHEME } from './commandResultsDocument';
import { copyToHost } from './remoteCopyUi';
import { downloadRemote } from './remoteDownloadUi';
import { uploadToRemote } from './remoteUploadUi';
import { checkReleaseChannel } from './releaseCheck';
import { runCommandOnHosts } from './multiCommandUi';
import { SSHTunnelTreeItem } from './tunnelUi';
import { followPathInTerminal } from './utils/settings';
import { FileDetailsViewProvider } from './fileDetailsView';
import { SSHTreeDragAndDropController } from './connectionDragAndDrop';

export function activate(context: vscode.ExtensionContext) {
    setExtensionContext(context);
    checkSshTooling();

    // Not awaited: a marketplace that is slow or unreachable must not hold up
    // the extension starting.
    void checkReleaseChannel(context);

    const sshViewProvider = new SSHViewProvider(context);
    createSSHTreeView(context, sshViewProvider);

    registerEventListeners(context, sshViewProvider);
    const tunnels = new TunnelManager(
        connectionId => sshViewProvider.connections.find(connection => connection.id === connectionId)?.client
    );
    context.subscriptions.push(
        tunnels,
        tunnels.onDidChange(() => sshViewProvider.refresh())
    );
    sshViewProvider.setTunnelManager(tunnels);
    sshViewProvider.setCredentialStore(new CredentialStore(context.secrets));

    const commandResults = new CommandResultsDocuments();
    context.subscriptions.push(
        commandResults,
        vscode.workspace.registerTextDocumentContentProvider(RESULTS_SCHEME, commandResults)
    );

    registerCommands(context, sshViewProvider, tunnels, commandResults);
    monitorSSHConfigFile(context, sshViewProvider);

    registerTreeAndWebviewProviders(context, sshViewProvider);

    const pathFollower = new TerminalPathFollower(followPathInTerminal);
    const remoteFilesView = new RemoteFilesView(
        selection => {
            showRemoteItemDetails(selection);
            // Following a selection only makes sense for a single entry.
            if (selection.length === 1) {
                followSelectionInTerminal(selection[0], sshViewProvider, pathFollower);
            }
        },
        view =>
            new RemoteFilesDropController(() => {
                const provider = view.provider;
                return provider instanceof RemoteFileProvider ? provider : undefined;
            })
    );
    remoteFilesView.setProvider(new EmptyRemoteFileProvider());
    context.subscriptions.push(remoteFilesView);
    sshViewProvider.setRemoteFilesView(remoteFilesView);
    sshViewProvider.setPathFollower(pathFollower);

    const decorationProvider = new SSHTreeDecorationProvider(
        (connectionId: string) =>
            sshViewProvider.connections.some(connection => connection.id === connectionId && !!connection.client),
        (folderPath: string) =>
            countInFolder(
                sshViewProvider.connections.map(connection => connection.vFolderTag),
                folderPath
            )
    );
    context.subscriptions.push(decorationProvider, vscode.window.registerFileDecorationProvider(decorationProvider));
    sshViewProvider.setDecorationProvider(decorationProvider);

    const detailsView = new FileDetailsViewProvider();
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(FileDetailsViewProvider.viewId, detailsView));
    sshViewProvider.setDetailsView(detailsView);

    context.subscriptions.push(
        vscode.commands.registerCommand('sshMultiConnect.editPermissions', async (node: RemoteFileTreeItem) => {
            const provider = node?.connection && RemoteFileProvider.getProviderByConnectionId(node.connection.id);
            if (!provider) {
                vscode.window.showErrorMessage('No remote file provider found for this item.');
                return;
            }
            await provider.editPermissions(node);
        })
    );
}

/**
 * Shows the selected remote item's details in the Edit Permissions panel.
 *
 * The panel is updated but not focused, so browsing the tree with the arrow
 * keys is not interrupted.
 *
 * @param selection What is selected in the remote files tree.
 */
function showRemoteItemDetails(selection: readonly vscode.TreeItem[]): void {
    const entries = selection.filter((item): item is RemoteFileTreeItem => item instanceof RemoteFileTreeItem);
    if (entries.length === 0) {
        return;
    }

    const provider = RemoteFileProvider.getProviderByConnectionId(entries[0].connection.id);
    const shown = entries.length === 1 ? provider?.showDetails(entries[0]) : provider?.showSelectionSummary(entries);

    shown?.catch((error: unknown) => {
        console.error('Could not show details for the selection:', error);
    });
}

/**
 * Changes the connection's terminal to the selected directory, when enabled.
 *
 * @param item The item selected in the remote files tree.
 * @param sshViewProvider Supplies the connection's terminal.
 * @param follower Decides whether a change is warranted.
 */
function followSelectionInTerminal(
    item: vscode.TreeItem,
    sshViewProvider: SSHViewProvider,
    follower: TerminalPathFollower
): void {
    if (!(item instanceof RemoteFileTreeItem)) {
        return;
    }

    const terminal = sshViewProvider.getTerminal(item.connection.id);
    if (!terminal) {
        return;
    }

    follower.follow(item.connection.id, item.resourceUri.path, item.isDirectory, text => terminal.sendText(text));
}

function createSSHTreeView(
    context: vscode.ExtensionContext,
    sshViewProvider: SSHViewProvider
): vscode.TreeView<SSHTreeNode> {
    const sshTreeView = vscode.window.createTreeView('sshConnectionsView', {
        treeDataProvider: sshViewProvider,
        showCollapseAll: true,
        canSelectMany: true,
        dragAndDropController: new SSHTreeDragAndDropController(sshViewProvider),
    });

    const showConnectionCount = () => {
        sshTreeView.badge = activeConnectionBadge(sshViewProvider.connections);
    };
    showConnectionCount();

    context.subscriptions.push(
        sshTreeView,
        sshTreeView.onDidChangeSelection(event => handleTreeViewSelection(event, sshViewProvider)),
        sshViewProvider.onDidChangeTreeData(showConnectionCount)
    );

    return sshTreeView;
}

function handleTreeViewSelection(
    event: vscode.TreeViewSelectionChangeEvent<SSHTreeNode>,
    sshViewProvider: SSHViewProvider
) {
    const selectedItem = event.selection[0];
    if (selectedItem instanceof SSHConnectionTreeItem) {
        sshViewProvider.selectConnection(selectedItem);
    }
}

function registerEventListeners(context: vscode.ExtensionContext, sshViewProvider: SSHViewProvider) {
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

function handleVisibleTextEditorsChange(editors: readonly vscode.TextEditor[], sshViewProvider: SSHViewProvider) {
    const activeEditor = editors.find(editor => editor.document.uri.scheme === 'ssh');
    if (activeEditor) {
        sshViewProvider.handleRemoteFileSelectionChange(activeEditor.document.uri);
    }
}

function registerCommands(
    context: vscode.ExtensionContext,
    sshViewProvider: SSHViewProvider,
    tunnels: TunnelManager,
    commandResults: CommandResultsDocuments
) {
    const commands = [
        { command: 'sshMultiConnect.addConnection', callback: () => addSSHConnection(sshViewProvider) },
        { command: 'sshMultiConnect.quickConnect', callback: () => sshViewProvider.quickConnect() },
        {
            command: 'sshMultiConnect.forgetPassword',
            callback: (treeItem: SSHConnectionTreeItem) => sshViewProvider.forgetPassword(treeItem),
        },
        {
            command: 'sshMultiConnect.connect',
            callback: (treeItem: SSHConnectionTreeItem) => sshViewProvider.connect(treeItem),
        },
        {
            command: 'sshMultiConnect.disconnect',
            callback: (treeItem: SSHConnectionTreeItem) => sshViewProvider.disconnect(treeItem),
        },
        {
            command: 'sshMultiConnect.editConnection',
            callback: (treeItem: SSHConnectionTreeItem) => sshViewProvider.editConnection(treeItem),
        },
        {
            command: 'sshMultiConnect.removeConnection',
            callback: (treeItem: SSHConnectionTreeItem) => sshViewProvider.removeConnection(treeItem),
        },
        {
            command: 'sshMultiConnect.moveToFolder',
            callback: (treeItem: SSHConnectionTreeItem) => sshViewProvider.moveConnectionToFolder(treeItem),
        },
        {
            command: 'sshMultiConnect.openRemoteFile',
            callback: async (first: unknown, second: unknown) => openRemoteFile(first, second),
        },
        {
            command: 'sshMultiConnect.renameRemote',
            callback: (node: RemoteFileTreeItem) => withRemoteProvider(node, provider => provider.renameItem(node)),
        },
        {
            command: 'sshMultiConnect.deleteRemote',
            callback: (node: RemoteFileTreeItem, selection?: RemoteFileTreeItem[]) =>
                withRemoteProvider(node, provider => provider.deleteItem(selected(node, selection))),
        },
        {
            command: 'sshMultiConnect.addTunnel',
            callback: (treeItem: SSHConnectionTreeItem) => sshViewProvider.addTunnel(treeItem),
        },
        {
            command: 'sshMultiConnect.startTunnel',
            callback: (item: SSHTunnelTreeItem) => tunnels.start(item.connectionId, item.entry.config.id),
        },
        {
            command: 'sshMultiConnect.stopTunnel',
            callback: (item: SSHTunnelTreeItem) => tunnels.stop(item.connectionId, item.entry.config.id),
        },
        {
            command: 'sshMultiConnect.keepTunnel',
            callback: (item: SSHTunnelTreeItem) => sshViewProvider.keepTunnel(item.connectionId, item.entry.config),
        },
        {
            command: 'sshMultiConnect.removeTunnel',
            callback: (item: SSHTunnelTreeItem) => tunnels.remove(item.connectionId, item.entry.config.id),
        },
        {
            command: 'sshMultiConnect.openSettings',
            // Filtering by the extension's own id shows exactly its settings,
            // and survives a rename of the publisher or the extension.
            callback: () =>
                vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
        },
        {
            command: 'sshMultiConnect.uploadToRemote',
            callback: (node: RemoteFileTreeItem | undefined) =>
                uploadToRemote(
                    node?.connection.id ?? sshViewProvider.activeRemoteConnectionId,
                    node ? { path: node.resourceUri.path, isDirectory: node.isDirectory } : undefined
                ),
        },
        {
            command: 'sshMultiConnect.downloadRemote',
            callback: (node: RemoteFileTreeItem, selection?: RemoteFileTreeItem[]) =>
                downloadRemote(
                    node.connection,
                    selected(node, selection).map(entry => ({
                        path: entry.resourceUri.path,
                        isDirectory: entry.isDirectory,
                    }))
                ),
        },
        {
            command: 'sshMultiConnect.copyToHost',
            callback: (node: RemoteFileTreeItem, selection?: RemoteFileTreeItem[]) =>
                copyToHost(
                    node.connection,
                    selected(node, selection).map(entry => ({
                        path: entry.resourceUri.path,
                        isDirectory: entry.isDirectory,
                    })),
                    {
                        hosts: () => sshViewProvider.connections,
                        ensureConnected: connection => sshViewProvider.ensureConnected(connection),
                        addHost: spec => sshViewProvider.addAndConnect(spec),
                    },
                    destination => sshViewProvider.getRemoteFileProvider(destination.id)?.refresh()
                ),
        },
        {
            command: 'sshMultiConnect.copyRemotePath',
            callback: (node: RemoteFileTreeItem, selection?: RemoteFileTreeItem[]) =>
                withRemoteProvider(node, provider => provider.copyPath(selected(node, selection))),
        },
        { command: 'sshMultiConnect.refreshRemoteFiles', callback: () => refreshRemoteFiles(sshViewProvider) },
        { command: 'sshMultiConnect.openMultiCommandPanel', callback: () => sshViewProvider.openMultiCommandPanel() },
        {
            command: 'sshMultiConnect.runOnHosts',
            callback: () =>
                runCommandOnHosts(
                    sshViewProvider.connections
                        .filter(connection => connection.client)
                        .map(connection => ({
                            host: connection.user ? `${connection.user}@${connection.host}` : connection.host,
                            client: connection.client!,
                        })),
                    commandResults
                ),
        },
        {
            command: 'sshMultiConnect.createRemoteFile',
            callback: (node: RemoteFileTreeItem) =>
                RemoteFileProvider.getProviderByConnectionId(node.connection.id)?.createRemoteFile(node),
        },
        {
            command: 'sshMultiConnect.createRemoteFolder',
            callback: (node: RemoteFileTreeItem) =>
                RemoteFileProvider.getProviderByConnectionId(node.connection.id)?.createRemoteFolder(node),
        },
    ];

    commands.forEach(({ command, callback }) => {
        context.subscriptions.push(vscode.commands.registerCommand(command, callback));
    });
}

/**
 * The entries a command should act on.
 *
 * VS Code passes the clicked item first and the whole selection second, but
 * only when the tree allows several; the second is missing for a command run
 * from the palette or a single-selection tree.
 *
 * @param node The item the command was invoked on.
 * @param selection Everything selected, when there is more than one.
 * @returns The entries to act on.
 */
function selected(node: RemoteFileTreeItem, selection?: RemoteFileTreeItem[]): RemoteFileTreeItem[] {
    return selection && selection.length > 0 ? selection : [node];
}

/**
 * Runs an action against the provider that owns a tree item.
 *
 * @param node The item the command was invoked on.
 * @param action What to do with its provider.
 */
function withRemoteProvider(
    node: RemoteFileTreeItem,
    action: (provider: RemoteFileProvider) => Promise<void> | void
): void {
    const provider = node?.connection && RemoteFileProvider.getProviderByConnectionId(node.connection.id);
    if (!provider) {
        vscode.window.showErrorMessage('No remote file provider found for this item.');
        return;
    }

    void Promise.resolve(action(provider)).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Remote file action failed: ${message}`);
    });
}

/**
 * Opens a remote file, however the command was invoked.
 *
 * Clicking a row passes `[resourceUri, connection]` from the item's own
 * command, while the context menu passes the tree item itself.
 *
 * @param first The URI or the tree item.
 * @param second The connection, when the first argument is a URI.
 */
async function openRemoteFile(first: unknown, second: unknown) {
    const target =
        first instanceof RemoteFileTreeItem
            ? { uri: first.resourceUri, connectionId: first.connection?.id }
            : first instanceof vscode.Uri
              ? { uri: first, connectionId: (second as ExtendedSSHConnection | undefined)?.id }
              : undefined;

    if (!target?.connectionId) {
        vscode.window.showErrorMessage('Invalid connection ID.');
        return;
    }

    const remoteFileProvider = RemoteFileProvider.getProviderByConnectionId(target.connectionId);
    if (remoteFileProvider) {
        await remoteFileProvider.openRemoteFile(target.uri);
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
    } catch {
        // No ssh_config yet is the normal state on a fresh machine; it is
        // created when the first connection is added.
    }
}

function registerTreeAndWebviewProviders(context: vscode.ExtensionContext, sshViewProvider: SSHViewProvider) {
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('multiCommandView', {
            resolveWebviewView: webviewView => {
                const connectedConnections = sshViewProvider.connections.filter(conn => conn.client);
                const multiCommandPanel = new MultiCommandPanel(webviewView, connectedConnections);

                sshViewProvider.setMultiCommandPanel(multiCommandPanel);
                sshViewProvider.refresh();
            },
        })
    );
}

export function deactivate() {
    RemoteFileProvider.disposeAll();
}
