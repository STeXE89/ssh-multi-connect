import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * What a split terminal actually is, as far as an extension can tell.
 *
 * VS Code exposes no way to read a terminal's group, so this proves the part
 * that is checkable: that a terminal backed by a pty accepts a parent, and
 * that the option survives into the terminal VS Code hands back. Whether the
 * panes end up side by side is only visible on screen.
 */

/** A pty that does nothing, so no shell or connection is involved. */
function silentPty(): vscode.Pseudoterminal {
    const writer = new vscode.EventEmitter<string>();
    return { onDidWrite: writer.event, open: () => undefined, close: () => undefined };
}

suite('splitting a terminal', () => {
    test('a pty-backed terminal accepts a parent to split from', async () => {
        const parent = vscode.window.createTerminal({ name: 'parent', pty: silentPty() });

        try {
            const child = vscode.window.createTerminal({
                name: 'child',
                pty: silentPty(),
                location: { parentTerminal: parent },
            });

            try {
                // creationOptions is what VS Code kept, so a location that was
                // rejected or dropped shows up here as missing.
                const location = (child.creationOptions as vscode.ExtensionTerminalOptions).location as
                    vscode.TerminalSplitLocationOptions | undefined;

                assert.ok(location, 'the split location did not survive into the terminal');
                assert.strictEqual(location.parentTerminal, parent);
            } finally {
                child.dispose();
            }
        } finally {
            parent.dispose();
        }
    });

    test('a terminal opened without one carries no location', () => {
        const alone = vscode.window.createTerminal({ name: 'alone', pty: silentPty() });

        try {
            assert.strictEqual((alone.creationOptions as vscode.ExtensionTerminalOptions).location, undefined);
        } finally {
            alone.dispose();
        }
    });
});
