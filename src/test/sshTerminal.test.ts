import * as assert from 'assert';
import { EventEmitter } from 'events';
import type { Client } from 'ssh2';
import { SSHPseudoterminal } from '../sshTerminal';

/** A stand-in for an ssh2 shell channel. */
class FakeChannel extends EventEmitter {
    readonly stderr = new EventEmitter();
    readonly written: string[] = [];
    readonly windows: number[][] = [];
    ended = false;

    write(data: string): void {
        this.written.push(data);
    }

    setWindow(rows: number, cols: number, height: number, width: number): void {
        this.windows.push([rows, cols, height, width]);
    }

    end(): void {
        this.ended = true;
    }
}

type ShellOpts = { rows?: number; cols?: number; term?: string };

/**
 * Builds a fake ssh2 Client whose `shell` either yields a channel or fails.
 * `deferred` withholds the callback so the "closed while opening" race can be
 * driven deterministically.
 */
function fakeClient(options: { error?: Error; deferred?: boolean } = {}) {
    const channel = new FakeChannel();
    const calls: ShellOpts[] = [];
    let release: (() => void) | undefined;

    const client = {
        shell(opts: ShellOpts, callback: (err: Error | undefined, ch: FakeChannel) => void) {
            calls.push(opts);
            const invoke = () => callback(options.error, channel);
            if (options.deferred) {
                release = invoke;
            } else {
                invoke();
            }
            return true;
        },
    } as unknown as Client;

    return { client, channel, calls, release: () => release?.() };
}

/** Collects everything the terminal writes to the VS Code terminal surface. */
function capture(pty: SSHPseudoterminal): string[] {
    const output: string[] = [];
    pty.onDidWrite(chunk => output.push(chunk));
    return output;
}

suite('SSHPseudoterminal', () => {
    test('opens a remote shell with the terminal dimensions', () => {
        const { client, calls } = fakeClient();
        const pty = new SSHPseudoterminal(client);

        pty.open({ rows: 40, columns: 100 });

        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].rows, 40);
        assert.strictEqual(calls[0].cols, 100);
        assert.strictEqual(calls[0].term, 'xterm-256color');
    });

    test('falls back to a default size when VS Code reports none', () => {
        const { client, calls } = fakeClient();

        new SSHPseudoterminal(client).open(undefined);

        assert.strictEqual(calls[0].rows, 24);
        assert.strictEqual(calls[0].cols, 80);
    });

    test('forwards stdout to the terminal', () => {
        const { client, channel } = fakeClient();
        const pty = new SSHPseudoterminal(client);
        const output = capture(pty);
        pty.open(undefined);

        channel.emit('data', Buffer.from('hello from the remote host'));

        assert.deepStrictEqual(output, ['hello from the remote host']);
    });

    test('forwards stderr to the terminal', () => {
        const { client, channel } = fakeClient();
        const pty = new SSHPseudoterminal(client);
        const output = capture(pty);
        pty.open(undefined);

        channel.stderr.emit('data', Buffer.from('permission denied'));

        assert.deepStrictEqual(output, ['permission denied']);
    });

    test('sends keystrokes to the remote shell', () => {
        // Terminal.sendText also lands here, which is how the multi-command
        // panel reaches each host.
        const { client, channel } = fakeClient();
        const pty = new SSHPseudoterminal(client);
        pty.open(undefined);

        pty.handleInput('uptime\n');

        assert.deepStrictEqual(channel.written, ['uptime\n']);
    });

    test('propagates a resize to the remote shell', () => {
        const { client, channel } = fakeClient();
        const pty = new SSHPseudoterminal(client);
        pty.open(undefined);

        pty.setDimensions({ rows: 50, columns: 120 });

        assert.deepStrictEqual(channel.windows, [[50, 120, 0, 0]]);
    });

    test('ends the channel when the terminal is closed', () => {
        const { client, channel } = fakeClient();
        const pty = new SSHPseudoterminal(client);
        pty.open(undefined);

        pty.close();

        assert.strictEqual(channel.ended, true);
    });

    test('reports a shell that fails to open and closes the terminal', () => {
        const { client } = fakeClient({ error: new Error('channel open failure') });
        const pty = new SSHPseudoterminal(client);
        const output = capture(pty);
        let exitCode: number | void = undefined;
        pty.onDidClose(code => {
            exitCode = code;
        });

        pty.open(undefined);

        assert.match(output.join(''), /channel open failure/);
        assert.strictEqual(exitCode, 1);
    });

    test('closes the terminal when the remote shell exits', () => {
        const { client, channel } = fakeClient();
        const pty = new SSHPseudoterminal(client);
        let closed = false;
        pty.onDidClose(() => {
            closed = true;
        });
        pty.open(undefined);

        channel.emit('close');

        assert.strictEqual(closed, true);
    });

    test('does not leak a channel that arrives after the terminal is gone', () => {
        // The user can dismiss the terminal while the channel is still being
        // negotiated; the late channel must be closed rather than retained.
        const { client, channel, release } = fakeClient({ deferred: true });
        const pty = new SSHPseudoterminal(client);
        pty.open(undefined);

        pty.close();
        release();

        assert.strictEqual(channel.ended, true);
    });

    test('surfaces a channel error without closing the terminal', () => {
        const { client, channel } = fakeClient();
        const pty = new SSHPseudoterminal(client);
        const output = capture(pty);
        pty.open(undefined);

        channel.emit('error', new Error('connection reset'));

        assert.match(output.join(''), /connection reset/);
    });

    test('ignores input and resizes before the shell is open', () => {
        const { client } = fakeClient({ deferred: true });
        const pty = new SSHPseudoterminal(client);
        pty.open(undefined);

        assert.doesNotThrow(() => {
            pty.handleInput('x');
            pty.setDimensions({ rows: 10, columns: 10 });
        });
    });
});
