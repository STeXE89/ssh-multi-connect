/**
 * Noticing when VS Code's split button has been used on a remote terminal.
 *
 * Its split action creates a terminal with a location and no configuration, so
 * it falls back to the default profile: a local shell, wearing the same split
 * group as the remote one it came from. Nothing about it says so, and the
 * commands typed into it run here rather than there -- which is worth a word
 * the first time it happens.
 */

/** What is known about a terminal that has just opened. */
export interface OpenedTerminal {
    /** Whether this extension created it. */
    ours: boolean;
    /** Whether it is backed by a pseudoterminal, as every remote shell is. */
    hasPty: boolean;
}

/**
 * Decides whether a newly opened terminal is a local split of a remote one.
 *
 * Only when the terminal is not ours, is a plain process terminal, and the
 * terminal being looked at a moment ago was one of ours: opening a local
 * terminal deliberately, from the panel or the palette, looks nothing like
 * that and should pass without comment.
 *
 * @param opened What just opened.
 * @param lastActiveWasOurs Whether a shell of ours was active before it.
 * @param alreadyExplained Whether the user has been told once already.
 * @returns True when it is worth explaining.
 */
export function isLocalSplitOfRemote(
    opened: OpenedTerminal,
    lastActiveWasOurs: boolean,
    alreadyExplained: boolean
): boolean {
    if (alreadyExplained || opened.ours || opened.hasPty) {
        return false;
    }

    return lastActiveWasOurs;
}
