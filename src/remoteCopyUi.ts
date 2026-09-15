/**
 * Copying a file or folder from one host to one or more others.
 *
 * The bytes travel through this machine -- read over one SSH connection and
 * written over each of the others -- rather than by asking any host to reach
 * another, which they usually cannot.
 */

import * as vscode from 'vscode';
import { ExtendedSSHConnection } from './sshConnection';
import * as sftpUtils from './utils/sftpUtils';
import {
    CopyPlan,
    DestinationCandidate,
    RemoteEntry,
    destinationRows,
    planRemoteCopy,
    posixBasename,
    posixJoin,
    refuseCopy,
} from './utils/remoteCopy';
import { posixParent } from './utils/dropTargets';
import { parseHostSpec } from './utils/proxyJump';

/** What the copy flow needs from the connection list. */
export interface HostAccess {
    /** Every saved host, connected or not. */
    hosts(): ExtendedSSHConnection[];
    /** Connects a host if it is not already, returning it once it is live. */
    ensureConnected(connection: ExtendedSSHConnection): Promise<ExtendedSSHConnection | undefined>;
    /** Saves a host that was typed in, and connects it. */
    addHost(spec: { host: string; user?: string; port?: number }): Promise<ExtendedSSHConnection | undefined>;
}

/** A destination offered in the picker. */
interface HostPick extends vscode.QuickPickItem {
    id?: string;
    other?: boolean;
}

/** How one destination fared. */
interface CopyOutcome {
    host: string;
    files: number;
    skipped: string[];
    error?: string;
}

/**
 * Asks where to copy an entry, then copies it to every host chosen.
 *
 * @param source The connection the entries live on.
 * @param entries The entries to copy.
 * @param access The connection list.
 * @param onCopied Called with each destination as its copies land.
 */
export async function copyToHost(
    source: ExtendedSSHConnection,
    entries: { path: string; isDirectory: boolean }[],
    access: HostAccess,
    onCopied?: (destination: ExtendedSSHConnection) => void
): Promise<void> {
    if (entries.length === 0) {
        return;
    }

    const what = entries.length === 1 ? posixBasename(entries[0].path) : `${entries.length} items`;
    const destinations = await chooseDestinations(source, what, access);
    if (destinations.length === 0) {
        return;
    }

    const intoSource = destinations.some(destination => destination.id === source.id);
    const names = destinations.map(destination => destination.host).join(', ');

    const destinationDir = await vscode.window.showInputBox({
        title: `Copy to ${names}`,
        value: posixParent(entries[0].path),
        prompt: `Folder on ${destinations.length === 1 ? names : 'each host'} to copy ${what} into`,
        validateInput: text => {
            const trimmed = text.trim();
            if (!trimmed.startsWith('/')) {
                return 'Enter an absolute path, starting with /.';
            }

            // Every entry has to be able to land there, not just the first.
            for (const entry of entries) {
                const refusal = refuseCopy(entry.path, trimmed, intoSource);
                if (refusal) {
                    return `${posixBasename(entry.path)}: ${refusal}`;
                }
            }

            return undefined;
        },
    });

    if (!destinationDir) {
        return;
    }

    const outcomes: CopyOutcome[] = [];
    for (const destination of destinations) {
        for (const entry of entries) {
            outcomes.push(await runCopy(source, entry.path, entry.isDirectory, destination, destinationDir.trim()));
        }
        onCopied?.(destination);
    }

    report(outcomes, destinationDir.trim());
}

/**
 * Picks the hosts to copy to, connecting any that are idle.
 *
 * Idle hosts are offered alongside the live ones, and a host that was never
 * saved can be typed in.
 *
 * @param source The connection the entries live on.
 * @param what Names what is being copied, for the prompt.
 * @param access The connection list.
 * @returns The live destinations, which may be empty if the user backed out.
 */
async function chooseDestinations(
    source: ExtendedSSHConnection,
    what: string,
    access: HostAccess
): Promise<ExtendedSSHConnection[]> {
    const hosts = access.hosts();
    const candidates: DestinationCandidate[] = hosts.map(connection => ({
        id: connection.id,
        host: connection.host,
        hostname: connection.hostname,
        user: connection.user,
        connected: !!connection.client,
    }));

    const picks: HostPick[] = destinationRows(candidates, source.id).map(row =>
        row.separator
            ? { label: row.label, kind: vscode.QuickPickItemKind.Separator }
            : { label: row.label, description: row.description, detail: row.detail, id: row.id, other: row.other }
    );

    const picked = await vscode.window.showQuickPick(picks, {
        placeHolder: `Copy ${what} to which host(s)?`,
        canPickMany: true,
        matchOnDescription: true,
        matchOnDetail: true,
    });

    if (!picked || picked.length === 0) {
        return [];
    }

    const destinations: ExtendedSSHConnection[] = [];

    for (const pick of picked) {
        const chosen = pick.other ? await askForHost(access) : await connectPicked(hosts, pick.id, access);

        // A host that could not be connected is reported by the connect flow;
        // the copy simply goes to the others.
        if (chosen && !destinations.some(destination => destination.id === chosen.id)) {
            destinations.push(chosen);
        }
    }

    return destinations;
}

/**
 * Connects a picked host if it is not already live.
 *
 * @param hosts Every saved host.
 * @param id The picked host's id.
 * @param access The connection list.
 * @returns The live connection, or undefined when it could not be connected.
 */
async function connectPicked(
    hosts: ExtendedSSHConnection[],
    id: string | undefined,
    access: HostAccess
): Promise<ExtendedSSHConnection | undefined> {
    const chosen = hosts.find(connection => connection.id === id);
    return chosen ? access.ensureConnected(chosen) : undefined;
}

/**
 * Asks for a host that is not in the list, and adds it.
 *
 * It becomes a normal connection rather than a one-off: every host this
 * extension knows is an ssh_config entry, and a throwaway would have nowhere
 * to keep its user, port or key.
 *
 * @param access The connection list.
 * @returns The new connection, once it is live.
 */
async function askForHost(access: HostAccess): Promise<ExtendedSSHConnection | undefined> {
    const spec = await vscode.window.showInputBox({
        title: 'Copy to another host',
        placeHolder: 'user@host, or host:port',
        prompt: 'Added to your connection list, so it is there next time',
        validateInput: text =>
            !text.trim() || parseHostSpec(text.trim()) ? undefined : 'Enter it as [user@]host[:port].',
    });

    const parsed = spec?.trim() ? parseHostSpec(spec.trim()) : undefined;
    if (!parsed) {
        return undefined;
    }

    return access.addHost({ host: parsed.host, user: parsed.user, port: parsed.port });
}

/**
 * Walks the source, then streams everything to one destination.
 *
 * @param source The connection to read from.
 * @param sourcePath The entry to copy.
 * @param isDirectory Whether it is a folder.
 * @param destination The connection to write to.
 * @param destinationDir The folder to copy into.
 * @returns How this destination fared.
 */
async function runCopy(
    source: ExtendedSSHConnection,
    sourcePath: string,
    isDirectory: boolean,
    destination: ExtendedSSHConnection,
    destinationDir: string
): Promise<CopyOutcome> {
    try {
        const from = await sftpUtils.getSFTPClient(source.client!);
        const to = await sftpUtils.getSFTPClient(destination.client!);

        const stat = await sftpUtils.getRemoteStat(from, sourcePath);
        const root: RemoteEntry = {
            path: sourcePath,
            isDirectory,
            isSymbolicLink: false,
            size: stat.size ?? 0,
            mode: stat.mode,
        };

        const plan = await planRemoteCopy(root, destinationDir, path => listRemote(from, path));
        const files = plan.steps.filter(step => step.kind === 'file');

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Copying ${posixBasename(sourcePath)} to ${destination.host}`,
                cancellable: true,
            },
            async (progress, token) => {
                let done = 0;
                for (const step of plan.steps) {
                    if (token.isCancellationRequested) {
                        return;
                    }

                    if (step.kind === 'directory') {
                        await sftpUtils.createRemoteDirectory(to, step.to).catch(() => undefined);
                        continue;
                    }

                    progress.report({ message: `${++done}/${files.length} ${step.to}` });
                    await streamFile(from, step.from, to, step.to);

                    if (step.mode !== undefined) {
                        // Keep an executable executable on the other side.
                        await sftpUtils.changeRemotePermissions(to, step.to, step.mode & 0o7777).catch(() => undefined);
                    }
                }
            }
        );

        return { host: destination.host, files: files.length, skipped: describeSkipped(plan) };
    } catch (error: any) {
        return { host: destination.host, files: 0, skipped: [], error: error.message };
    }
}

/** Names what a plan left out. */
function describeSkipped(plan: CopyPlan): string[] {
    return plan.skipped.map(entry => `${entry.name} (${entry.reason})`);
}

/**
 * Says what landed where, in one message however many hosts were involved.
 *
 * @param outcomes How each destination fared.
 * @param destinationDir The folder everything was copied into.
 */
function report(outcomes: CopyOutcome[], destinationDir: string): void {
    const failed = outcomes.filter(outcome => outcome.error);
    const copied = outcomes.filter(outcome => !outcome.error);

    if (failed.length > 0) {
        vscode.window.showErrorMessage(
            `Copy failed on ${failed.map(outcome => `${outcome.host} (${outcome.error})`).join(', ')}.`
        );
    }

    if (copied.length === 0) {
        return;
    }

    const skipped = [...new Set(copied.flatMap(outcome => outcome.skipped))];
    const where = `${copied.map(outcome => outcome.host).join(', ')}:${destinationDir}`;
    const what = `Copied ${copied[0].files} file(s) to ${where}`;

    if (skipped.length > 0) {
        vscode.window.showWarningMessage(`${what}, skipping ${skipped.join(', ')}.`);
    } else {
        vscode.window.showInformationMessage(`${what}.`);
    }
}

/**
 * Lists a remote directory in the shape the planner expects.
 *
 * @param sftp The source host's SFTP session.
 * @param directory The directory to list.
 * @returns Its entries.
 */
async function listRemote(sftp: any, directory: string): Promise<RemoteEntry[]> {
    const entries = await sftpUtils.readRemoteDirectory(sftp, directory);

    return entries.map((entry: any) => ({
        path: posixJoin(directory, entry.filename),
        isDirectory: !!entry.attrs?.isDirectory?.(),
        isSymbolicLink: !!entry.attrs?.isSymbolicLink?.(),
        size: entry.attrs?.size ?? 0,
        mode: entry.attrs?.mode,
    }));
}

/**
 * Streams one file between two SFTP sessions.
 *
 * Piped rather than buffered, so a large file does not have to fit in memory.
 *
 * @param from The source session.
 * @param fromPath The file to read.
 * @param to The destination session.
 * @param toPath The file to write.
 */
function streamFile(from: any, fromPath: string, to: any, toPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const read = from.createReadStream(fromPath);
        const write = to.createWriteStream(toPath);

        const fail = (error: Error) => {
            read.destroy();
            write.destroy();
            reject(error);
        };

        read.on('error', fail);
        write.on('error', fail);
        write.on('close', () => resolve());

        read.pipe(write);
    });
}
