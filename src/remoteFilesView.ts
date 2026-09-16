import * as vscode from 'vscode';

/**
 * Owns the single `remoteFilesView` tree and delegates to the active connection.
 *
 * Each connection has its own RemoteFileProvider. A long-lived TreeView that
 * forwards to whichever provider is current keeps one registration for the
 * view and, unlike `registerTreeDataProvider`, reports selection changes.
 */
export class RemoteFilesView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> = this.changeEmitter.event;

    private readonly treeView: vscode.TreeView<vscode.TreeItem>;
    private delegate?: vscode.TreeDataProvider<vscode.TreeItem>;
    private delegateSubscription?: vscode.Disposable;

    /**
     * @param onSelect Called with everything selected in the tree.
     * @param dragAndDrop Builds the controller for files dropped onto the
     * tree. It is passed this view, so it can read whichever provider is
     * current at the moment of the drop.
     */
    constructor(
        onSelect: (selection: readonly vscode.TreeItem[]) => void,
        dragAndDrop?: (view: RemoteFilesView) => vscode.TreeDragAndDropController<vscode.TreeItem>
    ) {
        this.treeView = vscode.window.createTreeView('remoteFilesView', {
            treeDataProvider: this,
            dragAndDropController: dragAndDrop?.(this),
            // Several entries can be dragged or acted on at once.
            canSelectMany: true,
        });

        this.treeView.onDidChangeSelection(event => {
            if (event.selection.length > 0) {
                onSelect(event.selection);
            }
        });
    }

    /**
     * Switches the tree to another connection's provider.
     *
     * @param provider The provider to show, or undefined to empty the tree.
     */
    /** The provider currently backing the tree. */
    get provider(): vscode.TreeDataProvider<vscode.TreeItem> | undefined {
        return this.delegate;
    }

    setProvider(provider: vscode.TreeDataProvider<vscode.TreeItem> | undefined): void {
        this.delegateSubscription?.dispose();
        this.delegateSubscription = undefined;
        this.delegate = provider;

        if (provider?.onDidChangeTreeData) {
            this.delegateSubscription = provider.onDidChangeTreeData(() => this.changeEmitter.fire());
        }

        this.changeEmitter.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
        return this.delegate ? this.delegate.getTreeItem(element) : element;
    }

    getChildren(element?: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem[]> {
        return this.delegate ? this.delegate.getChildren(element) : [];
    }

    dispose(): void {
        this.delegateSubscription?.dispose();
        this.treeView.dispose();
        this.changeEmitter.dispose();
    }
}
