import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fileUtils from './utils/fileUtils';
import * as sftpUtils from './utils/sftpUtils';
import { SSHConnection } from './sshConnection';

export class RemoteFileViewTitle extends vscode.TreeItem {
    constructor(label: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
    }
}

export class RemoteFileProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> = this._onDidChangeTreeData.event;

    private titleItem?: RemoteFileViewTitle;
    private sftp?: any;
    private tempFiles: Map<string, Set<string>> = new Map();
    private tempFileMap: Map<string, string> = new Map();
    private fileLists: Map<string, RemoteFileTreeItem[]> = new Map();

    constructor(private connection: SSHConnection, private currentPath: string) {
        this.refresh();
        this.registerEventListeners();
    }

    private registerEventListeners() {
        vscode.workspace.onDidCloseTextDocument(this.onDidCloseTextDocument.bind(this));
        vscode.workspace.onDidSaveTextDocument(this.onDidSaveTextDocument.bind(this));
        vscode.window.onDidChangeVisibleTextEditors(this.onDidChangeVisibleTextEditors.bind(this));
    
        const treeView = vscode.window.createTreeView('remoteFilesView', { treeDataProvider: this });
        treeView.onDidExpandElement(this.onDidExpandElement.bind(this));
        treeView.onDidCollapseElement(this.onDidCollapseElement.bind(this));
    
        vscode.commands.registerCommand('sshMultiConnect.createRemoteFolder', this.createRemoteFolder.bind(this));
    }

    setTitleItem(titleItem: RemoteFileViewTitle) {
        this.titleItem = titleItem;
        this.refresh();
    }

    updateConnection(connection: SSHConnection, remotePath: string) {
        this.connection = connection;
        this.currentPath = remotePath;
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
        if (!element) {
            const items: vscode.TreeItem[] = this.titleItem ? [this.titleItem] : [];
            return this.fetchRemoteFiles(this.currentPath).then(files => items.concat(files));
        }

        if (element instanceof RemoteFileTreeItem && element.isDirectory) {
            return this.fetchRemoteFiles(element.resourceUri.path);
        }

        return Promise.resolve([]);
    }

    private async fetchRemoteFiles(remotePath: string): Promise<RemoteFileTreeItem[]> {
        try {
            if (!this.sftp) {
                this.sftp = await sftpUtils.getSFTPClient(this.connection.client!);
            }
            const list = await sftpUtils.readRemoteDirectory(this.sftp, remotePath);

            const sortedList = this.sortRemoteFiles(list);
            this.fileLists.set(remotePath, sortedList);

            return sortedList.map(item => this.createRemoteFileTreeItem(remotePath, item));
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error fetching remote files: ${error.message}`);
            return [];
        }
    }

    private sortRemoteFiles(list: any[]): any[] {
        const directories = list.filter(item => item.attrs.isDirectory()).sort((a, b) => a.filename.toLowerCase().localeCompare(b.filename.toLowerCase()));
        const files = list.filter(item => !item.attrs.isDirectory()).sort((a, b) => a.filename.toLowerCase().localeCompare(b.filename.toLowerCase()));
        return [...directories, ...files];
    }

    private createRemoteFileTreeItem(remotePath: string, item: any): RemoteFileTreeItem {
        let resourceUriPath = `${remotePath}/${item.filename}`;
        if (resourceUriPath.startsWith('//')) {
            resourceUriPath = resourceUriPath.slice(1);
        }

        const resourceUri = vscode.Uri.parse(`ssh://${this.connection.username}@${this.connection.host}:${this.connection.port}${resourceUriPath}`);
        return new RemoteFileTreeItem(resourceUri, item.attrs.isDirectory() ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None, this.connection, item.attrs.isDirectory());
    }

    private async createRemoteFolder(node: RemoteFileTreeItem) {
        const folderName = await vscode.window.showInputBox({ prompt: 'Enter the name of the new remote folder' });
        if (!folderName) {
            return;
        }
    
        const remotePath = `${node.resourceUri.path}/${folderName}`;
        try {
            if (!this.sftp) {
                this.sftp = await sftpUtils.getSFTPClient(this.connection.client!);
            }
            await sftpUtils.createRemoteDirectory(this.sftp, remotePath);
            vscode.window.showInformationMessage(`Folder created: ${remotePath}`);
            this.refresh();
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error creating folder: ${error.message}`);
        }
    }

    private onDidExpandElement(event: vscode.TreeViewExpansionEvent<vscode.TreeItem>): void {
        // Handle expand event if needed
    }

    private onDidCollapseElement(event: vscode.TreeViewExpansionEvent<vscode.TreeItem>): void {
        // Handle collapse event if needed
    }

    private async onDidCloseTextDocument(document: vscode.TextDocument) {
        const filePath = document.uri.fsPath;
        for (const [connection, files] of this.tempFiles.entries()) {
            if (files.has(filePath)) {
                try {
                    await fileUtils.deleteFile(filePath);
                    files.delete(filePath);
                    this.tempFileMap.delete(filePath);
                    if (files.size === 0) {
                        this.tempFiles.delete(connection);
                    }
                } catch (err) {
                    console.error(`Failed to delete temporary file: ${filePath}`, err);
                }
                break;
            }
        }
    }

    private async onDidSaveTextDocument(document: vscode.TextDocument) {
        const filePath = document.uri.fsPath;
        const remotePath = this.tempFileMap.get(filePath);
        if (remotePath) {
            console.log(`Saving document. Local path: ${filePath}, Remote path: ${remotePath}`);
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Uploading file to remote server...",
                cancellable: false
            }, async (progress) => {
                await sftpUtils.uploadRemoteFile(this.sftp, filePath, remotePath);
                progress.report({ increment: 100 });
            });
            try {
                await fileUtils.deleteFile(filePath);
                for (const files of this.tempFiles.values()) {
                    files.delete(filePath);
                }
                this.tempFileMap.delete(filePath);
            } catch (err) {
                console.error(`Failed to delete temporary file: ${filePath}`, err);
            }
        } else {
            vscode.window.showErrorMessage('Remote path not found for the saved document.');
        }
    }

    private onDidChangeVisibleTextEditors(editors: readonly vscode.TextEditor[]) {
        const openFiles = new Set(editors.map(editor => editor.document.uri.fsPath));
        for (const [connection, files] of this.tempFiles.entries()) {
            files.forEach(filePath => {
                if (openFiles.has(filePath)) {
                    const document = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath === filePath);
                    if (document) {
                        vscode.commands.executeCommand('setContext', 'sshConnectionActive', true);
                        vscode.commands.executeCommand('sshMultiConnect.selectConnection', connection);
                        vscode.commands.executeCommand('terminalView.changeTerminal', connection);
                        vscode.window.registerTreeDataProvider('remoteFilesView', this);
                    }
                }
            });
        }
    }

    public async openRemoteFile(resourceUri: vscode.Uri) {
        try {
            if (!this.sftp) {
                this.sftp = await sftpUtils.getSFTPClient(this.connection.client!);
            }

            const stat = await sftpUtils.getRemoteStat(this.sftp, resourceUri.path);

            if (stat.isFile()) {
                await this.openRemoteFileInEditor(resourceUri);
            } else {
                vscode.window.showErrorMessage('Unsupported file type.');
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error opening remote file: ${error.message}`);
            this.sftp = undefined;
        }
    }

    private async openRemoteFileInEditor(resourceUri: vscode.Uri) {
        const localFileName = `${this.connection.host}_${path.basename(resourceUri.fsPath)}`;
        const localPath = path.join(os.tmpdir(), localFileName);
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Downloading file from remote server...",
            cancellable: false
        }, async (progress) => {
            await sftpUtils.downloadRemoteFile(this.sftp, resourceUri.path, localPath);
            progress.report({ increment: 100 });
        });
        if (!this.tempFiles.has(this.connection.host)) {
            this.tempFiles.set(this.connection.host, new Set());
        }
        this.tempFiles.get(this.connection.host)!.add(localPath);
        this.tempFileMap.set(localPath, resourceUri.path);
        const localUri = vscode.Uri.file(localPath);
        const document = await vscode.workspace.openTextDocument(localUri);
        await vscode.window.showTextDocument(document);
    }

    public async cleanup() {
        for (const document of vscode.workspace.textDocuments) {
            const filePath = document.uri.fsPath;
            if (this.tempFiles.has(filePath)) {
                await vscode.window.showTextDocument(document);
                await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
            }
        }

        for (const files of this.tempFiles.values()) {
            for (const filePath of files) {
                try {
                    await fileUtils.deleteFile(filePath);
                } catch (err) {
                    console.error(`Failed to delete temporary file: ${filePath}`, err);
                }
            }
        }
        this.tempFiles.clear();
    }
}

export class RemoteFileTreeItem extends vscode.TreeItem {
    constructor(
        public readonly resourceUri: vscode.Uri,
        collapsibleState: vscode.TreeItemCollapsibleState,
        private readonly connection: SSHConnection,
        public readonly isDirectory: boolean
    ) {
        super(resourceUri, collapsibleState);
        this.tooltip = resourceUri.fsPath;
        this.description = resourceUri.fsPath;
        this.contextValue = isDirectory ? 'remoteDirectory' : 'remoteFile';
        this.command = isDirectory ? undefined : {
            command: 'sshMultiConnect.openRemoteFile',
            title: 'Open File',
            arguments: [resourceUri, connection]
        };
        this.id = resourceUri.toString();
    }
}

export class EmptyRemoteFileProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> = this._onDidChangeTreeData.event;

    private titleItem?: RemoteFileViewTitle;

    setTitleItem(titleItem: RemoteFileViewTitle) {
        this.titleItem = titleItem;
        this.refresh();
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: vscode.TreeItem): Thenable<vscode.TreeItem[]> {
        if (!element) {
            return Promise.resolve(this.titleItem ? [this.titleItem] : []);
        }
        return Promise.resolve([]);
    }
}