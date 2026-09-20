/**
 * Remembering the commands sent from the multi-command panel.
 *
 * The commands people run across a fleet are the same handful every time --
 * `uptime`, `df -h`, `systemctl status something` -- and retyping them is the
 * panel's most obvious friction.
 */

/** How many to keep. Beyond this the list stops being a shortcut. */
export const HISTORY_LIMIT = 25;

/**
 * Adds a command to the history.
 *
 * Most recent first, with any earlier use of the same command removed rather
 * than left as a duplicate, so the list reads as a set of things you run.
 *
 * @param history The commands remembered so far.
 * @param command The command just sent.
 * @param limit How many to keep.
 * @returns The new history.
 */
export function rememberCommand(history: readonly string[], command: string, limit = HISTORY_LIMIT): string[] {
    const trimmed = command.trim();
    if (!trimmed) {
        return [...history];
    }

    return [trimmed, ...history.filter(entry => entry !== trimmed)].slice(0, Math.max(1, limit));
}

/**
 * Reads a history back from storage, defending against whatever is there.
 *
 * Stored state outlives the code that wrote it, so a value of the wrong shape
 * should empty the list rather than break the panel.
 *
 * @param stored Whatever was in storage.
 * @returns The commands, or an empty list.
 */
export function readHistory(stored: unknown): string[] {
    if (!Array.isArray(stored)) {
        return [];
    }

    return stored.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}
