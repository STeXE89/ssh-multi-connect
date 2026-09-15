/**
 * Drag and drop on the remote file tree.
 *
 * Two kinds of drop are accepted. Files dragged in from the operating system
 * or VS Code's own explorer arrive as a `text/uri-list` and are uploaded;
 * entries dragged within the tree itself are moved, which on the server is a
 * rename.
 */

import * as vscode from 'vscode';
import { RemoteFileProvider, RemoteFileTreeItem } from './remoteFile';
import { dropDestination, localPathsFromUriList } from './utils/dropTargets';
import { MoveSource } from './utils/remoteMove';

/** The payload VS Code uses for files dragged in from outside a tree. */
const URI_LIST = 'text/uri-list';

/**
 * The payload for a drag within this tree.
 *
 * VS Code reserves `application/vnd.code.tree.<view id, lowercased>` for a
 * tree's own drags and will not hand it to anyone else.
 */
const TREE_ITEMS = 'application/vnd.code.tree.remotefilesview';

/** What a drag within the tree carries. */
interface DraggedEntries {
    connectionId: string;
    entries: MoveSource[];
}

export class RemoteFilesDropController implements vscode.TreeDragAndDropController<vscode.TreeItem> {
    readonly dropMimeTypes = [URI_LIST, TREE_ITEMS];

    /**
     * Only this tree's own type is offered.
     *
     * Declaring `text/uri-list` here would be worse than useless: VS Code
     * fills the drag's uri-list from the items' own `resourceUri`, then blanks
     * every mime a controller declares, so claiming it empties the list. There
     * is no way to hand a remote file to the explorer either -- extension drag
     * data is resolved through an internal service that only other trees
     * consult. Download... is the way out.
     */
    readonly dragMimeTypes = [TREE_ITEMS];

    /**
     * @param activeProvider Supplies the provider for the connection on show.
     */
    constructor(private readonly activeProvider: () => RemoteFileProvider | undefined) {}

    handleDrag(source: readonly vscode.TreeItem[], dataTransfer: vscode.DataTransfer): void {
        const entries = source.filter((item): item is RemoteFileTreeItem => item instanceof RemoteFileTreeItem);
        if (entries.length === 0) {
            return;
        }

        dataTransfer.set(
            TREE_ITEMS,
            new vscode.DataTransferItem({
                connectionId: entries[0].connection.id,
                entries: entries.map(entry => ({ path: entry.resourceUri.path, isDirectory: entry.isDirectory })),
            } satisfies DraggedEntries)
        );
    }

    async handleDrop(
        target: vscode.TreeItem | undefined,
        dataTransfer: vscode.DataTransfer,
        token: vscode.CancellationToken
    ): Promise<void> {
        const provider = this.activeProvider();
        if (!provider || token.isCancellationRequested) {
            return;
        }

        const node = target instanceof RemoteFileTreeItem ? target : undefined;
        const destination = dropDestination(
            node ? { path: node.resourceUri.path, isDirectory: node.isDirectory } : undefined,
            provider.rootPath
        );

        const dragged = dataTransfer.get(TREE_ITEMS);
        if (dragged) {
            await this.moveWithin(dragged, destination, provider);
            return;
        }

        const uris = dataTransfer.get(URI_LIST);
        if (!uris) {
            return;
        }

        const localPaths = localPathsFromUriList(await uris.asString(), value => vscode.Uri.parse(value, true));
        if (localPaths.length === 0) {
            vscode.window.showWarningMessage('Only files on this machine can be uploaded.');
            return;
        }

        await provider.upload(destination, localPaths);
    }

    /**
     * Moves entries dragged from this tree into another of its folders.
     *
     * @param dragged The payload put there by handleDrag.
     * @param destination The folder they were dropped on.
     * @param provider The connection's provider.
     */
    private async moveWithin(
        dragged: vscode.DataTransferItem,
        destination: string,
        provider: RemoteFileProvider
    ): Promise<void> {
        const payload = dragged.value as DraggedEntries | undefined;
        if (!payload?.entries?.length) {
            return;
        }

        // The tree shows one connection at a time, so this should not happen;
        // moving across hosts is a copy, not a rename, and Copy to Host does it.
        if (payload.connectionId !== provider.connectionId) {
            vscode.window.showWarningMessage('Use Copy to Host... to move something between two hosts.');
            return;
        }

        await provider.moveInto(destination, payload.entries);
    }
}
