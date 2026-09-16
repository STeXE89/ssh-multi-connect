import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import * as fileUtils from './utils/fileUtils';
import * as sftpUtils from './utils/sftpUtils';
import * as fs from 'fs';
import { quote } from './utils/shell';
import { describeUpload } from './utils/dropTargets';
import { MoveSource, describeMove, planMove } from './utils/remoteMove';
import { planUpload, describeSkipped } from './utils/uploadPlan';
import { PrivilegeEscalation, isPermissionDenied, sudoCommands } from './utils/privilege';
import {
    FileDetailsViewProvider,
    RemoteAccount,
    RemoteFileInfo,
    formatBytes,
    renderDetails,
    renderEditor,
    renderSelection,
} from './fileDetailsView';
import { SelectedEntry, summariseSelection } from './utils/selectionSummary';
import { ExtendedSSHConnection } from './sshConnection';

/** Extracts a readable message from an unknown thrown value. */
function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves an account id to a `name (id)` label.
 *
 * @param accounts The remote account list.
 * @param id The uid or gid to look up.
 * @returns A display label, falling back to the bare id.
 */
function describeAccount(accounts: RemoteAccount[], id: string): string {
    const match = accounts.find(account => account.id === id);
    return match ? `${match.name} (${id})` : id;
}

/**
 * Recognises the error VS Code raises for content it will not open as text.
 *
 * @param error The error thrown by openTextDocument.
 * @returns True when the failure was binary detection.
 */
function isBinaryContentError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /seems to be binary|cannot be opened as text/i.test(message);
}

/**
 * Builds a transfer callback that drives a VS Code progress notification.
 *
 * `fastGet`/`fastPut` report absolute totals, while `progress.report` takes an
 * increment, so the previous value is tracked and the delta reported. The
 * transfer is aborted by throwing from the callback, which is the only hook
 * ssh2 offers for cancellation mid-transfer.
 *
 * @param progress The progress reporter from withProgress.
 * @param cancellation The token from withProgress.
 * @returns A callback for the sftp transfer helpers.
 */
function reportTransfer(
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    cancellation: vscode.CancellationToken
): sftpUtils.TransferProgress {
    let lastPercent = 0;

    return (transferred, total) => {
        if (cancellation.isCancellationRequested) {
            throw new Error('Transfer cancelled.');
        }

        if (!total) {
            progress.report({ message: formatBytes(transferred) });
            return;
        }

        const percent = Math.min(100, Math.floor((transferred / total) * 100));
        progress.report({
            increment: percent - lastPercent,
            message: `${percent}% of ${formatBytes(total)}`,
        });
        lastPercent = percent;
    };
}

export class RemoteFileViewTitle extends vscode.TreeItem {
    constructor(label: string) {
        super(label, vscode.TreeItemCollapsibleState.None);
    }
}

export class RemoteFileProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private static connectionProviders: Map<string, RemoteFileProvider> = new Map();

    private _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> = new vscode.EventEmitter<
        vscode.TreeItem | undefined | void
    >();
    readonly onDidChangeTreeData: vscode.Event<vscode.TreeItem | undefined | void> = this._onDidChangeTreeData.event;

    private titleItem?: RemoteFileViewTitle;
    private sftp?: any;
    private tempFileMap: Map<string, string> = new Map();
    private fileLists: Map<string, RemoteFileTreeItem[]> = new Map();
    private subscriptions: vscode.Disposable[] = [];
    /** /etc/passwd and /etc/group, fetched once per connection. */
    private accountsCache?: { users: RemoteAccount[]; groups: RemoteAccount[] };
    /** Guards against an older selection rendering over a newer one. */
    private infoRequestToken = 0;
    private readonly elevation: PrivilegeEscalation;

    constructor(
        private connection: ExtendedSSHConnection,
        private currentPath: string
    ) {
        RemoteFileProvider.connectionProviders.set(connection.id, this);
        this.elevation = new PrivilegeEscalation(
            () => this.connection.client,
            () => (this.connection.user ? `${this.connection.user}@${this.connection.host}` : this.connection.host)
        );
        this.refresh();
        this.registerEventListeners();
    }

    public static getProviderByConnectionId(connectionId: string): RemoteFileProvider | undefined {
        return RemoteFileProvider.connectionProviders.get(connectionId);
    }

    public static createOrGetProvider(connection: ExtendedSSHConnection, currentPath: string): RemoteFileProvider {
        const existing = RemoteFileProvider.getProviderByConnectionId(connection.id);
        if (existing) {
            existing.updateConnection(connection, currentPath);
            return existing;
        }
        // The constructor registers the new provider.
        return new RemoteFileProvider(connection, currentPath);
    }

    /** The connection whose files this provider serves. */
    public get connectionId(): string {
        return this.connection.id;
    }

    public static removeProviderByConnectionId(connectionId: string): void {
        RemoteFileProvider.connectionProviders.delete(connectionId);
    }

    /** Runs an action against every live provider. */
    public static forEachProvider(action: (provider: RemoteFileProvider) => void): void {
        for (const provider of RemoteFileProvider.connectionProviders.values()) {
            action(provider);
        }
    }

    /** Cleans up every live provider. Used on extension deactivation. */
    public static disposeAll(): void {
        for (const provider of [...RemoteFileProvider.connectionProviders.values()]) {
            provider.cleanup();
        }
        RemoteFileProvider.connectionProviders.clear();
        fileUtils.removePrivateTempDir();
    }

    private registerEventListeners() {
        // Disposables so that disconnecting detaches them.
        this.subscriptions.push(
            vscode.workspace.onDidCloseTextDocument(this.onDidCloseTextDocument.bind(this)),
            vscode.workspace.onDidSaveTextDocument(this.onDidSaveTextDocument.bind(this))
        );
    }

    setTitleItem(titleItem: RemoteFileViewTitle) {
        this.titleItem = titleItem;
        this.refresh();
    }

    updateConnection(connection: ExtendedSSHConnection, remotePath: string) {
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
            if (!this.connection.client) {
                vscode.window.showErrorMessage('SSH connection is not established.');
                return [];
            }
            if (!this.sftp) {
                this.sftp = await sftpUtils.getSFTPClient(this.connection.client);
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
        const directories = list
            .filter(item => item.attrs.isDirectory())
            .sort((a, b) => a.filename.toLowerCase().localeCompare(b.filename.toLowerCase()));
        const files = list
            .filter(item => !item.attrs.isDirectory())
            .sort((a, b) => a.filename.toLowerCase().localeCompare(b.filename.toLowerCase()));
        return [...directories, ...files];
    }

    private createRemoteFileTreeItem(remotePath: string, item: any): RemoteFileTreeItem {
        const resourceUri = this.createResourceUri(remotePath, item.filename);
        return new RemoteFileTreeItem(
            resourceUri,
            item.attrs.isDirectory() ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
            this.connection,
            item.attrs.isDirectory()
        );
    }

    private createResourceUri(remotePath: string, filename: string): vscode.Uri {
        let resourceUriPath = `${remotePath}/${filename}`;
        if (resourceUriPath.startsWith('//')) {
            resourceUriPath = resourceUriPath.slice(1);
        }
        return vscode.Uri.parse(
            `ssh://${this.connection.user}@${this.connection.hostname}:${this.connection.port}${resourceUriPath}`
        );
    }

    public async createRemoteFile(node: RemoteFileTreeItem) {
        const fileName = await vscode.window.showInputBox({ prompt: 'Enter the name of the new remote file' });
        if (!fileName) {
            return;
        }

        const remotePath = `${node.resourceUri.path}/${fileName}`;

        if (!(await this.ensureSftp())) {
            return;
        }

        const created = await this.attempt(
            `create ${remotePath}`,
            () => sftpUtils.createRemoteFile(this.sftp, remotePath),
            () => this.elevation.runOrThrow(sudoCommands.touch(remotePath)).then(() => undefined)
        );

        if (!created) {
            return;
        }

        vscode.window.showInformationMessage(`File created: ${remotePath}`);
        this.refresh();

        await this.openRemoteFile(this.createResourceUri(node.resourceUri.path, fileName));
    }

    /**
     * Opens the SFTP session if it is not open yet.
     *
     * @returns True when there is a session to work with.
     */
    private async ensureSftp(): Promise<boolean> {
        if (this.sftp) {
            return true;
        }

        if (!this.connection.client) {
            vscode.window.showErrorMessage(`Connect to ${this.connection.host} first.`);
            return false;
        }

        try {
            this.sftp = await sftpUtils.getSFTPClient(this.connection.client);
            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`Could not open an SFTP session: ${errorText(error)}`);
            return false;
        }
    }

    /** The folder shown at the top of this connection's tree. */
    public get rootPath(): string {
        return this.currentPath;
    }

    /**
     * Uploads local files and folders into a remote folder.
     *
     * The whole transfer is worked out first, so the progress bar can count
     * files rather than appear to stall on a deep tree.
     *
     * @param destination The remote folder to upload into.
     * @param localPaths The files and folders dragged in.
     */
    public async upload(destination: string, localPaths: string[]): Promise<void> {
        if (localPaths.length === 0) {
            return;
        }

        if (!this.connection.client) {
            vscode.window.showErrorMessage('Connect to the host before uploading files.');
            return;
        }

        try {
            if (!this.sftp) {
                this.sftp = await sftpUtils.getSFTPClient(this.connection.client);
            }

            const plan = await planUpload(localPaths, destination);
            const files = plan.steps.filter(step => step.kind === 'file');

            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: describeUpload(localPaths, destination) },
                async (progress, token) => {
                    let done = 0;
                    for (const step of plan.steps) {
                        if (token.isCancellationRequested) {
                            return;
                        }

                        if (step.kind === 'directory') {
                            // Already there is the normal case when adding to
                            // an existing tree, and is not a failure.
                            await sftpUtils.createRemoteDirectory(this.sftp, step.remotePath).catch(() => undefined);
                            continue;
                        }

                        progress.report({ message: `${++done}/${files.length} ${step.remotePath}` });
                        await sftpUtils.uploadRemoteFile(this.sftp, step.localPath, step.remotePath);
                    }
                }
            );

            this.refresh();

            const skipped = describeSkipped(plan);
            if (skipped) {
                vscode.window.showWarningMessage(`Uploaded to ${destination}, skipping ${skipped}.`);
            } else {
                vscode.window.showInformationMessage(`Uploaded ${files.length} file(s) to ${destination}.`);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Upload to ${destination} failed: ${error.message}`);
        }
    }

    public async createRemoteFolder(node: RemoteFileTreeItem) {
        const folderName = await vscode.window.showInputBox({ prompt: 'Enter the name of the new remote folder' });
        if (!folderName) {
            return;
        }

        const remotePath = `${node.resourceUri.path}/${folderName}`;

        if (!(await this.ensureSftp())) {
            return;
        }

        const created = await this.attempt(
            `create ${remotePath}`,
            () => sftpUtils.createRemoteDirectory(this.sftp, remotePath),
            () => this.elevation.runOrThrow(sudoCommands.mkdir(remotePath)).then(() => undefined)
        );

        if (created) {
            vscode.window.showInformationMessage(`Folder created: ${remotePath}`);
            this.refresh();
        }
    }

    private async onDidCloseTextDocument(document: vscode.TextDocument) {
        const filePath = document.uri.fsPath;

        const remotePath = this.tempFileMap.get(filePath);
        if (remotePath) {
            try {
                await fileUtils.deleteFile(filePath);

                this.tempFileMap.delete(filePath);
            } catch (err) {
                console.error(`Failed to delete temporary file: ${filePath}`, err);
            }
        }
    }

    private async onDidSaveTextDocument(document: vscode.TextDocument) {
        const filePath = document.uri.fsPath;
        const remotePath = this.tempFileMap.get(filePath);

        // Fires for every save in the window, so a document this provider
        // does not own is the normal case, not something to report.
        if (!remotePath) {
            return;
        }
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Uploading ${path.basename(remotePath)}`,
                cancellable: true,
            },
            async (progress, cancellation) => {
                try {
                    await sftpUtils.uploadRemoteFile(
                        this.sftp,
                        filePath,
                        remotePath,
                        reportTransfer(progress, cancellation)
                    );
                } catch (error) {
                    if (!isPermissionDenied(error) || !(await this.elevation.confirm(`save ${remotePath}`))) {
                        throw error;
                    }
                    await this.elevation.runOrThrow(sudoCommands.write(remotePath), fs.readFileSync(filePath));
                }
            }
        );

        // The local copy stays while the document is open, so later saves
        // still upload. onDidCloseTextDocument cleans it up.
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
        // The remote directory is folded in so two files sharing a basename on
        // one host do not collide locally.
        const remoteDirDigest = createHash('sha1')
            .update(`${this.connection.id}:${path.posix.dirname(resourceUri.path)}`)
            .digest('hex')
            .slice(0, 8);
        const localFileName = `${this.connection.host}_${remoteDirDigest}_${path.basename(resourceUri.path)}`;
        const localPath = path.join(fileUtils.getPrivateTempDir(), localFileName);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Downloading ${path.basename(resourceUri.path)}`,
                cancellable: true,
            },
            async (progress, cancellation) => {
                try {
                    await sftpUtils.downloadRemoteFile(
                        this.sftp,
                        resourceUri.path,
                        localPath,
                        reportTransfer(progress, cancellation)
                    );
                } catch (error) {
                    if (!isPermissionDenied(error) || !(await this.elevation.confirm(`read ${resourceUri.path}`))) {
                        throw error;
                    }
                    fs.writeFileSync(localPath, await this.elevation.runOrThrow(sudoCommands.read(resourceUri.path)));
                }
                // fastGet creates the file with the default mode.
                fileUtils.restrictToOwner(localPath);
            }
        );

        const localUri = vscode.Uri.file(localPath);

        try {
            const document = await vscode.workspace.openTextDocument(localUri);
            await vscode.window.showTextDocument(document);
        } catch (error) {
            // openTextDocument refuses binary content; let VS Code pick an
            // editor for it instead of forcing a text one.
            if (!isBinaryContentError(error)) {
                throw error;
            }

            await vscode.commands.executeCommand('vscode.open', localUri);
            vscode.window.showWarningMessage(
                `"${path.basename(resourceUri.path)}" is not a text file. Edits made here are not uploaded back to the remote host.`
            );
            return;
        }

        // Only text documents are tracked: onDidSaveTextDocument does not fire
        // for a custom or binary editor.
        this.tempFileMap.set(localPath, resourceUri.path);
    }

    private detailsView?: FileDetailsViewProvider;

    public setDetailsView(provider: FileDetailsViewProvider) {
        this.detailsView = provider;
    }

    /**
     * Reads the remote account lists, cached per connection so that selecting
     * items does not re-read /etc/passwd and /etc/group on every click.
     */
    private async getAccounts(): Promise<{ users: RemoteAccount[]; groups: RemoteAccount[] }> {
        if (!this.accountsCache) {
            // A server without /etc/passwd (a Windows or SFTP-only host) is not
            // an error: the panel falls back to showing raw uid and gid.
            const [users, groups] = await Promise.all([
                sftpUtils.getAvailableUsers(this.sftp).catch(() => [] as RemoteAccount[]),
                sftpUtils.getAvailableGroups(this.sftp).catch(() => [] as RemoteAccount[]),
            ]);
            this.accountsCache = { users, groups };
        }
        return this.accountsCache;
    }

    /**
     * Gathers everything the details panel shows for one item.
     *
     * @param node The item to describe.
     * @returns The details and account lists, or undefined if a newer request
     *   overtook this one.
     */
    private async collectInfo(
        node: RemoteFileTreeItem
    ): Promise<{ info: RemoteFileInfo; users: RemoteAccount[]; groups: RemoteAccount[] } | undefined> {
        if (!this.sftp) {
            this.sftp = await sftpUtils.getSFTPClient(this.connection.client!);
        }

        const token = ++this.infoRequestToken;
        const remotePath = node.resourceUri.path;

        const stat = await sftpUtils.getRemoteStat(this.sftp, remotePath);
        const { users, groups } = await this.getAccounts();
        const size = stat.isDirectory() ? await this.calculateFolderSize(remotePath) : formatBytes(stat.size);

        // A quicker selection may have overtaken this one.
        if (token !== this.infoRequestToken) {
            return undefined;
        }

        const uid = String(stat.uid);
        const gid = String(stat.gid);

        return {
            users,
            groups,
            info: {
                path: remotePath,
                type: stat.isDirectory() ? 'Directory' : 'File',
                size,
                modified: new Date(stat.mtime * 1000).toLocaleString(),
                created: stat.birthtime ? new Date(stat.birthtime * 1000).toLocaleString() : 'Unavailable',
                permissions: stat.mode.toString(8).slice(-3),
                uid,
                gid,
                owner: describeAccount(users, uid),
                group: describeAccount(groups, gid),
            },
        };
    }

    /**
     * Shows an item's details, read-only. Used when the tree selection changes,
     * so the panel is updated without taking focus from the tree.
     *
     * @param node The selected item.
     */
    /**
     * Runs an operation, offering to retry with sudo if permission is refused.
     *
     * @param description What is being attempted, used in the prompt.
     * @param operation The normal, unprivileged attempt.
     * @param elevated The same operation run as root.
     * @returns True when the operation succeeded, either way.
     */
    private async attempt(
        description: string,
        operation: () => Promise<void>,
        elevated: () => Promise<void>
    ): Promise<boolean> {
        try {
            await operation();
            return true;
        } catch (error) {
            if (!isPermissionDenied(error)) {
                vscode.window.showErrorMessage(`Could not ${description}: ${errorText(error)}`);
                return false;
            }

            if (!(await this.elevation.confirm(description))) {
                return false;
            }

            try {
                await elevated();
                return true;
            } catch (elevatedError) {
                vscode.window.showErrorMessage(`Could not ${description} with sudo: ${errorText(elevatedError)}`);
                return false;
            }
        }
    }

    /**
     * Deletes a file or folder after confirming with the user.
     *
     * Directories are emptied first. The confirmation is modal and names what
     * will go, because nothing here is recoverable from a trash can.
     *
     * @param node The item to delete.
     */
    public async deleteItem(nodes: RemoteFileTreeItem[]): Promise<void> {
        if (nodes.length === 0 || !(await this.ensureSftp())) {
            return;
        }

        const confirmed = await vscode.window.showWarningMessage(
            nodes.length === 1
                ? `Delete "${path.posix.basename(nodes[0].resourceUri.path)}" permanently?`
                : `Delete ${nodes.length} items permanently?`,
            { modal: true, detail: await this.describeDeletion(nodes) },
            'Delete'
        );

        if (confirmed !== 'Delete') {
            return;
        }

        let deleted = 0;
        for (const node of nodes) {
            const remotePath = node.resourceUri.path;

            const done = await this.attempt(
                `delete ${remotePath}`,
                () => sftpUtils.deleteRemoteEntry(this.sftp, remotePath, node.isDirectory),
                () => this.elevation.runOrThrow(sudoCommands.remove(remotePath, node.isDirectory)).then(() => undefined)
            );

            if (done) {
                this.forgetTempFilesUnder(remotePath);
                deleted++;
            }
        }

        if (deleted > 0) {
            vscode.window.showInformationMessage(`Deleted ${deleted} item${deleted === 1 ? '' : 's'}.`);
            this.refresh();
        }
    }

    /**
     * Spells out what a delete would take with it.
     *
     * A folder's contents are counted, since "delete" on a full folder is the
     * one people regret.
     *
     * @param nodes The entries about to be deleted.
     * @returns The confirmation's detail text.
     */
    private async describeDeletion(nodes: RemoteFileTreeItem[]): Promise<string> {
        const lines = [`On ${this.connection.host}:`];

        for (const node of nodes.slice(0, 10)) {
            const remotePath = node.resourceUri.path;

            if (!node.isDirectory) {
                lines.push(remotePath);
                continue;
            }

            const contained = await sftpUtils.countRemoteEntries(this.sftp, remotePath).catch(() => 0);
            lines.push(contained > 0 ? `${remotePath} and the ${contained} item(s) inside it` : remotePath);
        }

        if (nodes.length > 10) {
            lines.push(`and ${nodes.length - 10} more`);
        }

        return lines.join('\n');
    }

    /**
     * Renames a file or folder in place.
     *
     * @param node The item to rename.
     */
    /**
     * Moves entries into another folder on the same host.
     *
     * A move is a rename on the server, so it falls back to sudo the same way
     * a rename started from the menu does.
     *
     * @param destination The folder they were dropped on.
     * @param sources The entries being dragged.
     */
    public async moveInto(destination: string, sources: MoveSource[]): Promise<void> {
        const plan = planMove(sources, destination);

        if (plan.moves.length === 0) {
            const reasons = plan.skipped.map(entry => `${entry.name} (${entry.reason})`).join(', ');
            if (reasons) {
                vscode.window.showInformationMessage(`Nothing moved: ${reasons}.`);
            }
            return;
        }

        if (!(await this.ensureSftp())) {
            return;
        }

        let moved = 0;
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: describeMove(plan, destination) },
            async () => {
                for (const move of plan.moves) {
                    const done = await this.attempt(
                        `move ${move.from} to ${destination}`,
                        () => sftpUtils.renameRemote(this.sftp, move.from, move.to),
                        () => this.elevation.runOrThrow(sudoCommands.rename(move.from, move.to)).then(() => undefined)
                    );

                    if (done) {
                        moved++;
                    }
                }
            }
        );

        if (moved > 0) {
            this.refresh();
            vscode.window.showInformationMessage(`Moved ${moved} entr${moved === 1 ? 'y' : 'ies'} to ${destination}.`);
        }
    }

    public async renameItem(node: RemoteFileTreeItem): Promise<void> {
        const remotePath = node.resourceUri.path;
        const currentName = path.posix.basename(remotePath);

        const newName = await vscode.window.showInputBox({
            prompt: `Rename "${currentName}"`,
            value: currentName,
            validateInput: value => {
                const trimmed = value.trim();
                if (!trimmed) {
                    return 'A name is required.';
                }
                if (trimmed.includes('/')) {
                    return 'A name cannot contain "/".';
                }
                return undefined;
            },
        });

        if (!newName || newName.trim() === currentName) {
            return;
        }

        const target = path.posix.join(path.posix.dirname(remotePath), newName.trim());

        if (!this.sftp) {
            this.sftp = await sftpUtils.getSFTPClient(this.connection.client!);
        }

        const done = await this.attempt(
            `rename ${remotePath}`,
            () => sftpUtils.renameRemote(this.sftp, remotePath, target),
            () => this.elevation.runOrThrow(sudoCommands.rename(remotePath, target)).then(() => undefined)
        );

        if (done) {
            this.forgetTempFilesUnder(remotePath);
            vscode.window.showInformationMessage(`Renamed to ${newName.trim()}.`);
            this.refresh();
        }
    }

    /**
     * Copies an item's remote path to the clipboard.
     *
     * @param node The item whose path to copy.
     */
    public async copyPath(nodes: RemoteFileTreeItem[]): Promise<void> {
        if (nodes.length === 0) {
            return;
        }

        // One per line, which is what a shell or an editor expects when
        // several paths are pasted.
        const paths = nodes.map(node => node.resourceUri.path);
        await vscode.env.clipboard.writeText(paths.join('\n'));

        vscode.window.showInformationMessage(
            paths.length === 1 ? `Copied ${paths[0]}` : `Copied ${paths.length} paths`
        );
    }

    /**
     * Drops upload mappings for paths that no longer exist remotely.
     *
     * @param remotePath The path that was deleted or renamed.
     */
    private forgetTempFilesUnder(remotePath: string): void {
        for (const [localPath, mapped] of [...this.tempFileMap]) {
            if (mapped === remotePath || mapped.startsWith(`${remotePath}/`)) {
                this.tempFileMap.delete(localPath);
            }
        }
    }

    /**
     * Shows what a selection of several entries adds up to.
     *
     * Each is stat'd for its size; folders are counted but not measured, since
     * walking them on the server for every selection change would make the
     * tree unusable.
     *
     * @param nodes The selected entries.
     */
    public async showSelectionSummary(nodes: RemoteFileTreeItem[]): Promise<void> {
        if (!this.detailsView || !(await this.ensureSftp())) {
            return;
        }

        const entries: SelectedEntry[] = await Promise.all(
            nodes.map(async node => {
                const name = path.posix.basename(node.resourceUri.path);

                if (node.isDirectory) {
                    return { name, isDirectory: true, size: 0 };
                }

                try {
                    const stat = await sftpUtils.getRemoteStat(this.sftp, node.resourceUri.path);
                    return { name, isDirectory: false, size: stat.size ?? 0 };
                } catch {
                    // An entry that vanished should not lose the whole total.
                    return { name, isDirectory: false, size: 0 };
                }
            })
        );

        this.detailsView.setMessageHandler(() => undefined);
        this.detailsView.show(renderSelection(summariseSelection(entries)));
    }

    public async showDetails(node: RemoteFileTreeItem): Promise<void> {
        if (!this.detailsView) {
            return;
        }

        const collected = await this.collectInfo(node);
        if (!collected) {
            return;
        }

        const view = this.detailsView;
        view.setMessageHandler(message => {
            if (message?.command === 'editPermissions') {
                void this.editPermissions(node);
            }
        });
        await view.show(renderDetails(collected.info), false);
    }

    /**
     * Shows the editable permissions form and focuses the panel.
     *
     * @param node The item to edit.
     */
    public async editPermissions(node: RemoteFileTreeItem): Promise<void> {
        if (!this.detailsView) {
            vscode.window.showErrorMessage('The File Details panel is not available.');
            return;
        }

        const collected = await this.collectInfo(node);
        if (!collected) {
            return;
        }

        const view = this.detailsView;
        // Replaced, not stacked: Apply acts on the file now being shown.
        view.setMessageHandler(message => {
            if (message?.command === 'applyPermissions') {
                void this.applyPermissions(node, collected.info, message);
            } else if (message?.command === 'cancelEdit') {
                void this.showDetails(node);
            }
        });

        await view.show(renderEditor(collected.info, collected.users, collected.groups), true);
    }

    /**
     * Applies the mode, and the owner and group when they changed.
     *
     * The two are reported separately because chown needs privileges the user
     * often lacks, and that must not mask a successful chmod.
     *
     * @param node The tree item whose permissions are being changed.
     * @param info The details captured when the form was opened.
     * @param message The payload posted by the webview.
     */
    private async applyPermissions(
        node: RemoteFileTreeItem,
        info: RemoteFileInfo,
        message: { permissions: string; user: string; group: string }
    ): Promise<void> {
        const remotePath = node.resourceUri.path;
        const mode = parseInt(message.permissions, 8);

        if (!Number.isInteger(mode)) {
            vscode.window.showErrorMessage(`Invalid permission value: ${message.permissions}`);
            return;
        }

        const changed = await this.attempt(
            `change the permissions of ${remotePath}`,
            () => sftpUtils.changeRemotePermissions(this.sftp, remotePath, mode),
            () => this.elevation.runOrThrow(sudoCommands.chmod(remotePath, message.permissions)).then(() => undefined)
        );

        if (!changed) {
            return;
        }

        const ownershipChanged = message.user !== info.uid || message.group !== info.gid;

        if (ownershipChanged) {
            const reowned = await this.attempt(
                `change the owner of ${remotePath}`,
                () => sftpUtils.changeRemoteOwnership(this.connection.client!, remotePath, message.user, message.group),
                () =>
                    this.elevation
                        .runOrThrow(sudoCommands.chown(remotePath, message.user, message.group))
                        .then(() => undefined)
            );

            if (reowned) {
                vscode.window.showInformationMessage(`Permissions and ownership updated for ${remotePath}.`);
            }
        } else {
            vscode.window.showInformationMessage(`Permissions of ${remotePath} set to ${message.permissions}.`);
        }

        this.refresh();
        await this.showDetails(node);
    }

    private async calculateFolderSize(folderPath: string): Promise<string> {
        try {
            if (!this.connection.client) {
                throw new Error('SSH connection is not established.');
            }

            return new Promise((resolve, reject) => {
                this.connection.client?.exec(`du -sh ${quote(folderPath)}`, (err: any, stream: any) => {
                    if (err) {
                        reject(`Error executing remote command: ${err.message}`);
                        return;
                    }

                    let output = '';
                    let errorOutput = '';

                    stream.on('data', (data: Buffer) => {
                        output += data.toString();
                    });

                    stream.stderr.on('data', (data: Buffer) => {
                        errorOutput += data.toString();
                    });

                    stream.on('close', (code: number) => {
                        if (code !== 0) {
                            reject(new Error(errorOutput.trim() || `du exited with code ${code}`));
                        } else {
                            const size = output.split('\t')[0].trim();
                            resolve(size);
                        }
                    });
                });
            });
        } catch {
            // Reported in the panel rather than as a notification: selecting a
            // folder must not raise a popup on a host without `du`.
            return 'Unavailable';
        }
    }

    public cleanup(): void {
        RemoteFileProvider.removeProviderByConnectionId(this.connection.id);

        for (const subscription of this.subscriptions) {
            subscription.dispose();
        }
        this.subscriptions = [];
        this.elevation.forget();
        this.sftp = undefined;
        this.accountsCache = undefined;

        for (const document of vscode.workspace.textDocuments) {
            const filePath = document.uri.fsPath;
            if (this.tempFileMap.has(filePath)) {
                vscode.window.showTextDocument(document).then(() => {
                    vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                });
            }
        }

        for (const filePath of this.tempFileMap.keys()) {
            // deleteFile is async; catch the rejection rather than letting it
            // escape as an unhandled promise rejection.
            void fileUtils
                .deleteFile(filePath)
                .catch(err => console.error(`Failed to delete temporary file: ${filePath}`, err));
        }

        this.tempFileMap.clear();
    }
}

export class RemoteFileTreeItem extends vscode.TreeItem {
    constructor(
        public readonly resourceUri: vscode.Uri,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly connection: ExtendedSSHConnection,
        public readonly isDirectory: boolean
    ) {
        super(resourceUri, collapsibleState);
        this.tooltip = resourceUri.path;
        this.description = resourceUri.path;
        this.contextValue = isDirectory ? 'remoteDirectory' : 'remoteFile';
        this.command = isDirectory
            ? undefined
            : {
                  command: 'sshMultiConnect.openRemoteFile',
                  title: 'Open File',
                  arguments: [resourceUri, connection],
              };
        this.id = resourceUri.toString();
    }
}

export class EmptyRemoteFileProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly _onDidChangeTreeData: vscode.EventEmitter<vscode.TreeItem | undefined | void> =
        new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
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
