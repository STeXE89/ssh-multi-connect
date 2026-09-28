import * as path from 'path';
import { quote } from './utils/shell';

/**
 * Works out which directory a tree selection refers to.
 *
 * @param remotePath The selected path.
 * @param isDirectory Whether the selection is a directory.
 * @returns The directory to change to.
 */
export function directoryFor(remotePath: string, isDirectory: boolean): string {
    return isDirectory ? remotePath : path.posix.dirname(remotePath);
}

/**
 * Keeps a connection's terminal in step with the Remote Files selection.
 *
 * The directory change is typed into the terminal, so it is off by default and
 * only sent when the directory actually changes: selecting several files in
 * one folder must not repeat the command.
 */
export class TerminalPathFollower {
    private readonly lastDirectory = new Map<string, string>();

    /**
     * @param isEnabled Reads the user's setting, checked on every selection so
     *   toggling it takes effect immediately.
     */
    constructor(private readonly isEnabled: () => boolean) {}

    /**
     * Sends a directory change for a selection, if one is warranted.
     *
     * @param connectionId The connection the selection belongs to.
     * @param remotePath The selected path.
     * @param isDirectory Whether the selection is a directory.
     * @param send Writes a line to that connection's terminal.
     * @returns True when a command was sent.
     */
    follow(connectionId: string, remotePath: string, isDirectory: boolean, send: (text: string) => void): boolean {
        if (!this.isEnabled()) {
            return false;
        }

        const directory = directoryFor(remotePath, isDirectory);
        if (this.lastDirectory.get(connectionId) === directory) {
            return false;
        }

        this.lastDirectory.set(connectionId, directory);
        // The path comes from a remote listing, so it is quoted like any other
        // untrusted value reaching a shell.
        send(`cd ${quote(directory)}`);
        return true;
    }

    /**
     * Records a directory the terminal is already in.
     *
     * Used when the move came from the terminal rather than the tree, so the
     * tree does not turn around and send a `cd` back to where the shell
     * already is.
     *
     * @param connectionId The connection.
     * @param directory The directory the shell reported.
     */
    remember(connectionId: string, directory: string): void {
        this.lastDirectory.set(connectionId, directory);
    }

    /** Drops the remembered directory for a connection, e.g. on disconnect. */
    forget(connectionId: string): void {
        this.lastDirectory.delete(connectionId);
    }
}

/**
 * Picks the shell a connection's directory changes belong to.
 *
 * A host can have several shells open. The tree shows one directory, so
 * following has to mean the shell in front of the user, falling back to the
 * connection's own when the active terminal belongs to something else -- or to
 * nothing, as when the focus is in an editor.
 *
 * @param connectionId The connection being followed.
 * @param active The terminal in front of the user, and whose connection it is.
 * @param own The connection's first terminal.
 * @returns The terminal to send to, or undefined when there is none.
 */
export function chooseShell<T>(
    connectionId: string,
    active: { terminal: T; connectionId: string | undefined } | undefined,
    own: T | undefined
): T | undefined {
    return active && active.connectionId === connectionId ? active.terminal : own;
}
