/**
 * Searching a host's files from the tree.
 *
 * `grep` does the work on the far side, which is the whole point: the
 * alternative is dragging the files here to look at them. Building the command
 * and reading its output are the parts worth testing, and both are here.
 */

import { quote } from './shell';

/** What the user asked for. */
export interface SearchRequest {
    /** The text to look for. */
    pattern: string;
    /** The folder to look in. */
    directory: string;
    /** Whether case should be ignored. */
    ignoreCase: boolean;
    /** Whether the pattern is a regular expression rather than plain text. */
    regex: boolean;
    /** How many matches to bring back. */
    limit: number;
}

/** One line grep reported. */
export interface SearchHit {
    path: string;
    /** One-based, as grep counts and as an editor shows. */
    line: number;
    /** The matching line, trimmed for display. */
    preview: string;
}

/**
 * Builds the command to run on the host.
 *
 * Everything the user typed is quoted: a search for `$(reboot)` must look for
 * that text, not run it. `-F` makes a plain search plain, so a pattern full of
 * dots and brackets finds itself rather than becoming a regular expression.
 * Binary files are skipped, and unreadable directories stay quiet -- a search
 * of `/` should not bury its results in permission errors.
 *
 * @param request What to look for and where.
 * @returns The shell command to run.
 */
export function buildSearchCommand(request: SearchRequest): string {
    const flags = ['-rn', '--binary-files=without-match'];

    if (!request.regex) {
        flags.push('-F');
    }
    if (request.ignoreCase) {
        flags.push('-i');
    }

    // The limit is applied by grep itself, so a search that matches everything
    // stops early instead of streaming megabytes back.
    flags.push(`-m ${Math.max(1, Math.floor(request.limit))}`);

    return (
        `grep ${flags.join(' ')} -e ${quote(request.pattern)} -- ${quote(request.directory)} 2>/dev/null | ` +
        `head -n ${Math.max(1, Math.floor(request.limit))}`
    );
}

/**
 * Reads grep's output into hits.
 *
 * The format is `path:line:text`, and a path can itself contain colons, so the
 * split is anchored on the first colon followed by digits and another colon.
 * Anything that does not look like a match is skipped rather than guessed at.
 *
 * @param output What grep printed.
 * @returns The hits, in the order they were reported.
 */
export function parseSearchOutput(output: string): SearchHit[] {
    const hits: SearchHit[] = [];

    for (const line of output.split('\n')) {
        const match = /^(.*?):(\d+):(.*)$/.exec(line);
        if (!match) {
            continue;
        }

        const [, path, number, text] = match;
        if (!path) {
            continue;
        }

        hits.push({ path, line: Number.parseInt(number, 10), preview: text.trim().slice(0, 200) });
    }

    return hits;
}

/**
 * Describes a hit for the picker.
 *
 * The file name leads, since that is what is being chosen between; the folder
 * follows in the detail line.
 *
 * @param hit The match.
 * @param root The folder searched, trimmed from the front of the path.
 * @returns Label, description and detail for a quick pick item.
 */
export function describeHit(hit: SearchHit, root: string): { label: string; description: string; detail: string } {
    const name = hit.path.slice(hit.path.lastIndexOf('/') + 1);
    const folder = hit.path.slice(0, hit.path.lastIndexOf('/')) || '/';
    const relative = root !== '/' && folder.startsWith(root) ? folder.slice(root.length) || '/' : folder;

    return {
        label: `${name}:${hit.line}`,
        description: hit.preview,
        detail: relative,
    };
}
