/**
 * What the remote file view should show when a connection closes.
 *
 * The view's provider and the tree's selection are tracked separately and can
 * disagree: connecting a second host swaps the view without changing the
 * selection. Deciding from both, rather than from the selection alone, is what
 * keeps a closed host's files from staying on screen.
 */

/** Where the remote file view should end up. */
export type RemoteViewAction =
    /** The closed connection was not on show; leave the view alone. */
    | { action: 'keep' }
    /** Show this connection instead. */
    | { action: 'show'; connectionId: string }
    /** Nothing is connected any more. */
    | { action: 'clear' };

/**
 * Decides what to do with the remote file view after a disconnect.
 *
 * @param closedId The connection that just closed.
 * @param showingId The connection whose files the view currently holds.
 * @param selectedId The connection selected in the tree.
 * @param liveIds The connections still open, in tree order.
 * @returns What the view should do.
 */
export function remoteViewAfterDisconnect(
    closedId: string,
    showingId: string | undefined,
    selectedId: string | undefined,
    liveIds: string[]
): RemoteViewAction {
    if (closedId !== showingId && closedId !== selectedId) {
        return { action: 'keep' };
    }

    const next = liveIds.find(id => id !== closedId);
    return next ? { action: 'show', connectionId: next } : { action: 'clear' };
}
