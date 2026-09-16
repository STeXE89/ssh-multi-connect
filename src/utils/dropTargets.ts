/**
 * Pure helpers for dropping local files onto the remote tree.
 *
 * Remote paths are always POSIX, whatever the local machine uses, so they are
 * built here rather than with `path.join`.
 */

import * as path from 'path';

/**
 * Reads the paths out of a `text/uri-list` payload.
 *
 * The format is one URI per line with `#` comments, and VS Code sends the
 * lines separated by CRLF. Only local files can be uploaded, so anything with
 * another scheme is dropped.
 *
 * @param list The payload text.
 * @returns The file system paths, in the order they were dragged.
 */
export function localPathsFromUriList(
    list: string,
    parse: (value: string) => { scheme: string; fsPath: string }
): string[] {
    return list
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'))
        .map(line => {
            try {
                return parse(line);
            } catch {
                return undefined;
            }
        })
        .filter((uri): uri is { scheme: string; fsPath: string } => uri?.scheme === 'file')
        .map(uri => uri.fsPath);
}

/**
 * Works out which remote folder a drop lands in.
 *
 * Dropping on a file means the folder holding it, which is what a file manager
 * does; dropping on nothing means the folder the tree is rooted at.
 *
 * @param target The item the files were dropped on, if any.
 * @param root The folder currently shown at the top of the tree.
 * @returns The remote folder to upload into.
 */
export function dropDestination(target: { path: string; isDirectory: boolean } | undefined, root: string): string {
    if (!target) {
        return root;
    }
    return target.isDirectory ? target.path : posixParent(target.path);
}

/**
 * Builds the remote path a local file is uploaded to.
 *
 * @param destination The remote folder.
 * @param localPath The file being uploaded.
 * @returns The full remote path.
 */
export function uploadPath(destination: string, localPath: string): string {
    const name = path.basename(localPath);
    return destination.endsWith('/') ? `${destination}${name}` : `${destination}/${name}`;
}

/**
 * The parent of a POSIX path.
 *
 * @param remotePath The path.
 * @returns Its parent, or `/` at the top.
 */
export function posixParent(remotePath: string): string {
    const trimmed = remotePath.replace(/\/+$/, '');
    const cut = trimmed.lastIndexOf('/');
    return cut <= 0 ? '/' : trimmed.slice(0, cut);
}

/**
 * Describes an upload for a progress title or a confirmation.
 *
 * @param localPaths The files being uploaded.
 * @param destination The remote folder.
 * @returns A sentence naming what goes where.
 */
export function describeUpload(localPaths: string[], destination: string): string {
    const what = localPaths.length === 1 ? `"${path.basename(localPaths[0])}"` : `${localPaths.length} files`;
    return `Uploading ${what} to ${destination}`;
}
