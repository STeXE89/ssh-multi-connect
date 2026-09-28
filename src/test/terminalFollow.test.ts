import * as assert from 'assert';
import { directoryFor, TerminalPathFollower, chooseShell } from '../terminalFollow';

/** Collects what would have been typed into the terminal. */
function recorder() {
    const sent: string[] = [];
    return { sent, send: (text: string) => sent.push(text) };
}

suite('terminalFollow: directoryFor', () => {
    test('uses a folder as-is', () => {
        assert.strictEqual(directoryFor('/var/log', true), '/var/log');
    });

    test('uses the parent folder of a file', () => {
        assert.strictEqual(directoryFor('/var/log/syslog', false), '/var/log');
    });

    test('handles a file at the root', () => {
        assert.strictEqual(directoryFor('/passwd', false), '/');
    });

    test('keeps POSIX separators whatever the local platform', () => {
        // The path is remote, so it must not be rewritten with backslashes.
        assert.ok(!directoryFor('/var/log/syslog', false).includes('\\'));
    });
});

suite('terminalFollow: TerminalPathFollower', () => {
    test('sends nothing while the setting is off', () => {
        const { sent, send } = recorder();
        const follower = new TerminalPathFollower(() => false);

        assert.strictEqual(follower.follow('web', '/var/log', true, send), false);
        assert.deepStrictEqual(sent, []);
    });

    test('changes directory for a selected folder', () => {
        const { sent, send } = recorder();
        const follower = new TerminalPathFollower(() => true);

        assert.strictEqual(follower.follow('web', '/var/log', true, send), true);
        assert.deepStrictEqual(sent, ["cd '/var/log'"]);
    });

    test('uses the parent folder for a selected file', () => {
        const { sent, send } = recorder();

        new TerminalPathFollower(() => true).follow('web', '/var/log/syslog', false, send);

        assert.deepStrictEqual(sent, ["cd '/var/log'"]);
    });

    test('does not repeat itself for files in the same folder', () => {
        // Arrow-keying through a directory listing must not spam the terminal.
        const { sent, send } = recorder();
        const follower = new TerminalPathFollower(() => true);

        follower.follow('web', '/var/log/a', false, send);
        follower.follow('web', '/var/log/b', false, send);
        follower.follow('web', '/var/log', true, send);

        assert.deepStrictEqual(sent, ["cd '/var/log'"]);
    });

    test('sends again when the folder really changes', () => {
        const { sent, send } = recorder();
        const follower = new TerminalPathFollower(() => true);

        follower.follow('web', '/var/log', true, send);
        follower.follow('web', '/etc', true, send);

        assert.deepStrictEqual(sent, ["cd '/var/log'", "cd '/etc'"]);
    });

    test('tracks each connection separately', () => {
        const { sent, send } = recorder();
        const follower = new TerminalPathFollower(() => true);

        follower.follow('web', '/var/log', true, send);
        follower.follow('db', '/var/log', true, send);

        assert.strictEqual(sent.length, 2);
    });

    test('quotes a hostile directory name', () => {
        // Remote listings are untrusted; a crafted folder name must not be
        // able to run a second command in the terminal.
        const { sent, send } = recorder();

        new TerminalPathFollower(() => true).follow('web', "/tmp/a'; rm -rf ~; '", true, send);

        assert.strictEqual(sent[0], "cd '/tmp/a'\\''; rm -rf ~; '\\'''");
    });

    test('reads the setting on every selection', () => {
        let enabled = false;
        const { sent, send } = recorder();
        const follower = new TerminalPathFollower(() => enabled);

        follower.follow('web', '/a', true, send);
        enabled = true;
        follower.follow('web', '/b', true, send);

        assert.deepStrictEqual(sent, ["cd '/b'"]);
    });

    test('forget makes the next selection send again', () => {
        const { sent, send } = recorder();
        const follower = new TerminalPathFollower(() => true);

        follower.follow('web', '/var/log', true, send);
        follower.forget('web');
        follower.follow('web', '/var/log', true, send);

        assert.strictEqual(sent.length, 2);
    });
});

suite('terminalFollow: choosing which shell follows', () => {
    const own = "the connection's own terminal";
    const second = 'a second shell on the same host';

    test('follows the shell in front of the user', () => {
        const active = { terminal: second, connectionId: 'web' };

        assert.strictEqual(chooseShell('web', active, own), second);
    });

    test("falls back to the connection's own when another host is active", () => {
        const active = { terminal: 'a shell on a different host', connectionId: 'other' };

        assert.strictEqual(chooseShell('web', active, own), own);
    });

    test('falls back when the active terminal is not a connection shell at all', () => {
        // A plain local terminal, or an editor has the focus.
        const active = { terminal: 'bash', connectionId: undefined };

        assert.strictEqual(chooseShell('web', active, own), own);
    });

    test('falls back when nothing is active', () => {
        assert.strictEqual(chooseShell('web', undefined, own), own);
    });

    test('has nothing to follow when the connection has no terminal', () => {
        assert.strictEqual(chooseShell('web', undefined, undefined), undefined);
    });

    test("still prefers the active shell when it is the connection's own", () => {
        const active = { terminal: own, connectionId: 'web' };

        assert.strictEqual(chooseShell('web', active, own), own);
    });
});
