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
