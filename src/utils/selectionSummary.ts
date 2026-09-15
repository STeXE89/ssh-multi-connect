/**
 * Describing a multiple selection in the File Details panel.
 *
 * One file shows its own details; several want an answer to a different
 * question -- how much is this, and how much would it weigh to move.
 */

/** One selected entry, as much as the summary needs. */
export interface SelectedEntry {
    name: string;
    isDirectory: boolean;
    /** Bytes, for files. Folders are not measured. */
    size: number;
}

/** What a selection adds up to. */
export interface SelectionSummary {
    files: number;
    folders: number;
    /** Total bytes of the selected files. */
    bytes: number;
    /** The names, in selection order, for the list. */
    names: string[];
}

/**
 * Adds up a selection.
 *
 * Folder sizes are left out rather than guessed: measuring one means walking
 * it on the server, which a selection change should not set off.
 *
 * @param entries The selected entries.
 * @returns The totals.
 */
export function summariseSelection(entries: SelectedEntry[]): SelectionSummary {
    return {
        files: entries.filter(entry => !entry.isDirectory).length,
        folders: entries.filter(entry => entry.isDirectory).length,
        bytes: entries.reduce((total, entry) => total + (entry.isDirectory ? 0 : entry.size), 0),
        names: entries.map(entry => entry.name),
    };
}

/**
 * Renders a selection's totals as a sentence.
 *
 * @param summary The totals.
 * @param formatBytes Renders a byte count the way the panel does elsewhere.
 * @returns A line such as `3 files, 1.4 MB · 1 folder`.
 */
export function describeSelection(summary: SelectionSummary, formatBytes: (bytes: number) => string): string {
    const parts: string[] = [];

    if (summary.files > 0) {
        parts.push(`${summary.files} file${summary.files === 1 ? '' : 's'}, ${formatBytes(summary.bytes)}`);
    }

    if (summary.folders > 0) {
        parts.push(`${summary.folders} folder${summary.folders === 1 ? '' : 's'}, not measured`);
    }

    return parts.join(' · ') || 'Nothing selected';
}
