/**
 * Planning a copy from one remote host to another.
 *
 * The walk is separated from the transfer so the awkward part -- recursion,
 * ordering, and what to leave out -- can be tested against a fake listing
 * rather than two live servers.
 */

import { posixParent } from './dropTargets';

/** One entry on a remote host. */
export interface RemoteEntry {
    path: string;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    size: number;
    /** POSIX permission bits, carried over so an executable stays one. */
    mode?: number;
}

/** Lists a remote directory. */
export type RemoteLister = (path: string) => Promise<RemoteEntry[]>;

/** One thing to create or send. */
export interface CopyStep {
    kind: 'directory' | 'file';
    from: string;
    to: string;
    size: number;
    mode?: number;
}

/** What a copy amounts to. */
export interface CopyPlan {
    steps: CopyStep[];
    skipped: { name: string; reason: string }[];
    /** Total bytes of the files to send. */
    bytes: number;
}

/**
 * The last segment of a POSIX path.
 *
 * @param remotePath The path.
 * @returns Its last segment, or an empty string at the root.
 */
export function posixBasename(remotePath: string): string {
    const trimmed = remotePath.replace(/\/+$/, '');
    return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/**
 * Joins a remote directory and a name.
 *
 * @param directory The directory.
 * @param name The entry name.
 * @returns The full path.
 */
export function posixJoin(directory: string, name: string): string {
    return directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`;
}

/**
 * Lists what copying an entry into a remote folder would do.
 *
 * Symbolic links are skipped rather than followed, as they are for an upload:
 * a link pointing back up its own tree would never finish, and the target it
 * names may not exist on the other host anyway.
 *
 * @param source The entry to copy.
 * @param destinationDir The folder on the other host.
 * @param list Lists a directory on the source host.
 * @returns The transfer, parents before their contents.
 */
export async function planRemoteCopy(
    source: RemoteEntry,
    destinationDir: string,
    list: RemoteLister
): Promise<CopyPlan> {
    const plan: CopyPlan = { steps: [], skipped: [], bytes: 0 };
    await addEntry(source, posixJoin(destinationDir, posixBasename(source.path)), list, plan);
    plan.bytes = plan.steps.reduce((total, step) => total + (step.kind === 'file' ? step.size : 0), 0);
    return plan;
}

/**
 * Adds one entry, and everything under it, to a plan.
 *
 * @param entry The entry to add.
 * @param to Where it lands.
 * @param list Lists a directory on the source host.
 * @param plan The plan being built.
 */
async function addEntry(entry: RemoteEntry, to: string, list: RemoteLister, plan: CopyPlan): Promise<void> {
    if (entry.isSymbolicLink) {
        plan.skipped.push({ name: posixBasename(entry.path), reason: 'symbolic link' });
        return;
    }

    if (!entry.isDirectory) {
        plan.steps.push({ kind: 'file', from: entry.path, to, size: entry.size, mode: entry.mode });
        return;
    }

    plan.steps.push({ kind: 'directory', from: entry.path, to, size: 0, mode: entry.mode });

    let children: RemoteEntry[];
    try {
        children = await list(entry.path);
    } catch (error) {
        plan.skipped.push({ name: posixBasename(entry.path), reason: (error as Error).message });
        return;
    }

    for (const child of [...children].sort((a, b) => a.path.localeCompare(b.path))) {
        await addEntry(child, posixJoin(to, posixBasename(child.path)), list, plan);
    }
}

/**
 * Reports whether a copy would write over its own source.
 *
 * Copying a folder into itself, or onto the same path on the same host, would
 * either loop or destroy the thing being copied.
 *
 * @param sourcePath The entry being copied.
 * @param destinationDir The folder it would land in.
 * @param sameHost Whether both ends are the same connection.
 * @returns A message when the copy must not go ahead.
 */
export function refuseCopy(sourcePath: string, destinationDir: string, sameHost: boolean): string | undefined {
    if (!sameHost) {
        return undefined;
    }

    if (destinationDir === posixParent(sourcePath)) {
        return 'The destination is where the file already is.';
    }

    const inside = `${sourcePath.replace(/\/+$/, '')}/`;
    if (destinationDir === sourcePath || destinationDir.startsWith(inside)) {
        return 'A folder cannot be copied into itself.';
    }

    return undefined;
}

/** A host offered as a copy destination. */
export interface DestinationCandidate {
    id: string;
    host: string;
    hostname: string;
    user?: string;
    connected: boolean;
}

/** One row of the destination picker. */
export interface DestinationRow {
    /** Absent on the group headings, which cannot be picked. */
    id?: string;
    label: string;
    description?: string;
    detail?: string;
    separator?: boolean;
    /** Set on the row that asks for a host that is not in the list. */
    other?: boolean;
}

/** The row that asks for a host that has never been saved. */
export const OTHER_HOST_ROW = 'Another host...';

/**
 * Builds the list of places a copy can go.
 *
 * Live connections come first, since copying to one starts immediately;
 * saved-but-idle hosts follow, and are connected on the way. The source
 * itself stays in the list: copying to another folder on the same host is a
 * normal thing to want.
 *
 * @param candidates Every saved host.
 * @param sourceId The connection the entry is being copied from.
 * @returns The rows to offer.
 */
export function destinationRows(candidates: DestinationCandidate[], sourceId: string): DestinationRow[] {
    const describe = (candidate: DestinationCandidate) =>
        candidate.user ? `${candidate.user}@${candidate.hostname}` : candidate.hostname;

    const row = (candidate: DestinationCandidate): DestinationRow => ({
        id: candidate.id,
        label: candidate.host,
        description: describe(candidate),
        detail:
            candidate.id === sourceId
                ? 'The host you are copying from, into another folder'
                : candidate.connected
                  ? undefined
                  : 'Not connected; it will be connected first',
    });

    const byName = [...candidates].sort((a, b) => a.host.localeCompare(b.host));
    const group = (items: DestinationCandidate[], heading: string): DestinationRow[] =>
        items.length === 0 ? [] : [{ label: heading, separator: true }, ...items.map(row)];

    return [
        ...group(
            byName.filter(candidate => candidate.connected),
            'Connected'
        ),
        ...group(
            byName.filter(candidate => !candidate.connected),
            'Not connected'
        ),
        { label: '', separator: true },
        {
            label: `$(add) ${OTHER_HOST_ROW}`,
            detail: 'A host that is not in the list. It is added to your connections.',
            other: true,
        },
    ];
}
