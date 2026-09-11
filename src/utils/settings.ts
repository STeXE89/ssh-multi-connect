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
