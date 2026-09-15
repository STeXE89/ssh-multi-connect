/**
 * Choosing which hosts a multi-host command goes to, and naming the terminals
 * it runs in.
 */

/** The part of a connection this module needs. */
export interface Selectable {
    id: string;
    host: string;
    user?: string;
}

/**
 * Picks the selected connections, in the order the panel lists them.
 *
 * The panel's selection is a set of ids; keeping the panel's own order means a
 * split terminal group reads the same way as the list above it.
 *
 * @param connections Every connection the panel offers.
 * @param selectedIds The ids the user ticked.
 * @returns The selected connections, in list order.
 */
export function selectedTargets<T extends Selectable>(connections: T[], selectedIds: string[]): T[] {
    const wanted = new Set(selectedIds);
    return connections.filter(connection => wanted.has(connection.id));
}

/**
 * Names a terminal in the multi-command group.
 *
 * Deliberately different from the name a connection's own terminal carries:
 * the two are tracked by name in places, and closing one must not be taken
 * for closing the other.
 *
 * @param connection The host the terminal belongs to.
 * @returns The terminal name.
 */
export function splitTerminalName(connection: Selectable): string {
    const account = connection.user ? `${connection.user}@${connection.host}` : connection.host;
    return `${account} · multi`;
}

/**
 * Works out which hosts still need a terminal in the group.
 *
 * @param targets The selected connections.
 * @param existing The ids that already have a live terminal.
 * @returns The connections to open a terminal for.
 */
export function missingTerminals<T extends Selectable>(targets: T[], existing: Set<string>): T[] {
    return targets.filter(target => !existing.has(target.id));
}
