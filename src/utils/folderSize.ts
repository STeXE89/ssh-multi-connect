/**
 * Reading what `du` reports for a folder.
 *
 * `du` exits non-zero when it meets a directory it cannot read, while still
 * printing a perfectly good total for everything it could. Treating that exit
 * code as failure loses the answer the user asked for, so the output is what
 * decides.
 */

/**
 * Turns `du -sh` output into something to show.
 *
 * @param stdout What du printed.
 * @param stderr What it complained about, if anything.
 * @returns The size, marked as partial when some of the tree was unreadable.
 */
export function parseFolderSize(stdout: string, stderr: string): string {
    const size = stdout.split('\t')[0].trim();

    if (!size) {
        return 'Unavailable';
    }

    // A total that skipped folders is not the folder's size, and saying so is
    // better than quietly reporting a number that is too small.
    return /permission denied|cannot read/i.test(stderr) ? `${size} or more` : size;
}
