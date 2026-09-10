import * as vscode from 'vscode';
import { SSHViewProvider, SSHConnectionTreeItem, SSHFolderTreeItem } from './sshConnection';

type TreeNode = SSHConnectionTreeItem | SSHFolderTreeItem;

/** VS Code derives this from the view id; it must stay lowercase. */
const MIME_TYPE = 'application/vnd.code.tree.sshconnectionsview';

/**
 * Lets connections and folders be dragged around the SSH Connections tree.
 *
 * Dropping onto a folder moves the item into it, dropping onto a connection
 * moves it alongside that connection, and dropping on empty space moves it to
 * the root.
 */
export class SSHTreeDragAndDropController implements vscode.TreeDragAndDropController<TreeNode> {
    readonly dragMimeTypes = [MIME_TYPE];
    readonly dropMimeTypes = [MIME_TYPE];

    constructor(private readonly viewProvider: SSHViewProvider) {}

    handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
        dataTransfer.set(MIME_TYPE, new vscode.DataTransferItem([...source]));
    }

    handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): void {
        const transferred = dataTransfer.get(MIME_TYPE);
        if (!transferred) {
            return;
        }

        const items = transferred.value as TreeNode[];
        if (!Array.isArray(items) || items.length === 0) {
            return;
        }

        this.viewProvider.handleDrop(items, destinationOf(target));
    }
}

/**
 * Works out which folder a drop target represents.
 *
 * @param target The item the drop landed on, or undefined for empty space.
 * @returns The destination folder path, or undefined for the root.
 */
export function destinationOf(target: TreeNode | undefined): string | undefined {
    if (target instanceof SSHFolderTreeItem) {
        return target.folderName;
    }
    if (target instanceof SSHConnectionTreeItem) {
        // Dropped on a connection: use that connection's folder.
        return target.connection.vFolderTag;
    }
    return undefined;
}
