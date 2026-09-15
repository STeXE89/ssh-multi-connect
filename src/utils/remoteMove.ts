/**
 * Planning a move inside one host's file tree.
 *
 * Dragging a file onto a folder is a rename on the server, but only some of
 * the drops a user can make are meaningful: a folder cannot go inside itself,
 * and dropping something back where it already is should do nothing rather
 * than fail.
 */

import { posixBasename, posixJoin } from './remoteCopy';
import { posixParent } from './dropTargets';

/** Something being dragged. */
export interface MoveSource {
    path: string;
    isDirectory: boolean;
}

/** What a drop amounts to. */
export interface MovePlan {
    moves: { from: string; to: string }[];
    /** Entries left where they were, and why. */
    skipped: { name: string; reason: string }[];
}

/**
 * Works out which of the dragged entries actually move.
 *
 * @param sources The entries being dragged.
 * @param destination The folder they were dropped on.
 * @returns The moves to make, and what was left out.
 */
export function planMove(sources: MoveSource[], destination: string): MovePlan {
    const plan: MovePlan = { moves: [], skipped: [] };

    for (const source of sources) {
        const name = posixBasename(source.path);
        const refusal = refuseMove(source, destination);

        if (refusal) {
            plan.skipped.push({ name, reason: refusal });
            continue;
        }

        plan.moves.push({ from: source.path, to: posixJoin(destination, name) });
    }

    return plan;
}

/**
 * Reports why an entry cannot move where it was dropped.
 *
 * @param source The entry being dragged.
 * @param destination The folder it was dropped on.
 * @returns A reason, or undefined when the move is fine.
 */
export function refuseMove(source: MoveSource, destination: string): string | undefined {
    if (destination === posixParent(source.path)) {
        return 'already there';
    }

    if (!source.isDirectory) {
        return undefined;
    }

    // Trailing slash included, so a sibling whose name merely starts the same
    // is not mistaken for a child.
    const inside = `${source.path.replace(/\/+$/, '')}/`;
    if (destination === source.path || destination.startsWith(inside)) {
        return 'a folder cannot be moved inside itself';
    }

    return undefined;
}

/**
 * Describes a move, for the progress title.
 *
 * @param plan The planned moves.
 * @param destination Where they are going.
 * @returns A sentence naming what moves where.
 */
export function describeMove(plan: MovePlan, destination: string): string {
    const what = plan.moves.length === 1 ? `"${posixBasename(plan.moves[0].from)}"` : `${plan.moves.length} entries`;
    return `Moving ${what} to ${destination}`;
}
