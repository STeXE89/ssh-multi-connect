import * as vscode from 'vscode';

/** The manifest's configuration section. */
const SECTION = 'sshMultiConnect';

/**
 * Whether selecting in Remote Files should change the terminal's directory.
 *
 * @returns The user's current preference.
 */
export function followPathInTerminal(): boolean {
    return vscode.workspace.getConfiguration(SECTION).get<boolean>('followPathInTerminal', false);
}

/**
 * Whether the multi-command panel should open its own split terminal group.
 *
 * @returns The user's current preference.
 */
export function splitTerminalsForMultiCommand(): boolean {
    return vscode.workspace.getConfiguration(SECTION).get<boolean>('splitTerminalsForMultiCommand', true);
}

/**
 * Whether a connection that drops should be rebuilt on its own.
 *
 * @returns The user's current preference.
 */
export function autoReconnect(): boolean {
    return vscode.workspace.getConfiguration(SECTION).get<boolean>('autoReconnect', true);
}

/**
 * How often to probe a connection the host's own config says nothing about.
 *
 * @returns The interval in seconds, where zero disables probing.
 */
export function keepaliveSeconds(): number {
    return vscode.workspace.getConfiguration(SECTION).get<number>('keepaliveInterval', 30);
}

/**
 * Whether the Remote Files tree should follow the terminal's directory.
 *
 * The other direction of `followPathInTerminal`: this one asks the shell to
 * report where it is, and moves the tree to match.
 *
 * @returns The user's current preference.
 */
export function followTerminalDirectory(): boolean {
    return vscode.workspace.getConfiguration(SECTION).get<boolean>('followTerminalDirectory', false);
}
