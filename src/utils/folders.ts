/**
 * Virtual folder helpers.
 *
 * Folders are not stored anywhere of their own: a connection's `vFolderTag`
 * holds a slash-separated path, and the tree is derived from those tags. These
 * functions are the pure part of that derivation.
 */

/** Splits a folder path into its non-empty segments. */
function segments(folderPath: string): string[] {
    return folderPath.split('/').filter(Boolean);
}

/**
 * Normalises a folder path, collapsing empty segments.
 *
 * @param folderPath The raw path, possibly with stray or repeated slashes.
 * @returns The cleaned path, or undefined when it names the root.
 */
export function normalizeFolderPath(folderPath: string | undefined): string | undefined {
    if (!folderPath) {
        return undefined;
    }
    const cleaned = segments(folderPath).join('/');
    return cleaned || undefined;
}

/**
 * Lists every folder path implied by a set of tags, parents included.
 *
 * A single tag of `A/B/C` implies the folders `A`, `A/B` and `A/B/C`, all of
 * which are valid move destinations.
 *
 * @param tags The `vFolderTag` values in use.
 * @returns The folder paths, sorted.
 */
export function collectFolderPaths(tags: (string | undefined)[]): string[] {
    const paths = new Set<string>();

    for (const tag of tags) {
        const parts = segments(tag ?? '');
        for (let depth = 1; depth <= parts.length; depth++) {
            paths.add(parts.slice(0, depth).join('/'));
        }
    }

    return [...paths].sort((a, b) => a.localeCompare(b));
}

/**
 * Reports whether moving a folder into a destination would nest it in itself.
 *
 * @param sourcePath The folder being moved.
 * @param destination The folder it would move into, or undefined for the root.
 * @returns True when the move is not allowed.
 */
export function isSelfNesting(sourcePath: string, destination: string | undefined): boolean {
    if (!destination) {
        return false;
    }
    return destination === sourcePath || destination.startsWith(`${sourcePath}/`);
}

/**
 * Computes a folder's path after it is moved under a new parent.
 *
 * @param sourcePath The folder being moved.
 * @param destination The new parent, or undefined for the root.
 * @returns The folder's new path.
 */
export function movedFolderPath(sourcePath: string, destination: string | undefined): string {
    const name = segments(sourcePath).pop() ?? sourcePath;
    return destination ? `${destination}/${name}` : name;
}

/**
 * Rewrites a tag that sits at or below a folder being moved.
 *
 * @param tag The connection's current tag.
 * @param sourcePath The folder being moved.
 * @param newFolderPath The folder's new path.
 * @returns The rewritten tag, or undefined when the tag is unaffected.
 */
export function reparentTag(tag: string | undefined, sourcePath: string, newFolderPath: string): string | undefined {
    if (!tag) {
        return undefined;
    }
    if (tag === sourcePath) {
        return newFolderPath;
    }
    if (tag.startsWith(`${sourcePath}/`)) {
        return newFolderPath + tag.slice(sourcePath.length);
    }
    return undefined;
}

/**
 * Counts the connections inside a folder, including its subfolders.
 *
 * @param tags The `vFolderTag` values in use.
 * @param folderPath The folder to count.
 * @returns How many connections live at or below that folder.
 */
export function countInFolder(tags: (string | undefined)[], folderPath: string): number {
    return tags.filter(tag => tag === folderPath || tag?.startsWith(`${folderPath}/`)).length;
}
