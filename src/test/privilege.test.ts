import * as assert from 'assert';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import type { Client } from 'ssh2';
import { isPermissionDenied, sudoCommands, PrivilegeEscalation } from '../utils/privilege';

suite('privilege: isPermissionDenied', () => {
    test('recognises the SFTP permission status', () => {
        assert.strictEqual(isPermissionDenied({ code: 3 }), true);
    });

    test('recognises POSIX error codes', () => {
        assert.strictEqual(isPermissionDenied({ code: 'EACCES' }), true);
        assert.strictEqual(isPermissionDenied({ code: 'EPERM' }), true);
    });

    test('recognises the message a shell reports', () => {
        assert.strictEqual(isPermissionDenied(new Error('rm: cannot remove: Permission denied')), true);
        assert.strictEqual(isPermissionDenied(new Error('Operation not permitted')), true);
    });

    test('does not mistake other failures for permission problems', () => {
        assert.strictEqual(isPermissionDenied(new Error('No such file or directory')), false);
        assert.strictEqual(isPermissionDenied({ code: 2 }), false);
        assert.strictEqual(isPermissionDenied(undefined), false);
    });
});

suite('privilege: command building', () => {
    test('a hostile path stays a single argument in a real shell', function () {
        // Checking for the payload as a substring proves nothing: correctly
        // quoted output contains it too. What matters is how a shell parses
        // the command, so `set --` is used to dump the argument list. The
        // payload is a harmless echo: if quoting ever broke, this test would
        // run it, and it must not be destructive.
        if (process.platform === 'win32') {
            this.skip();
        }

        const hostile = "/tmp/a'; echo INJECTED; '";

        for (const command of [
            sudoCommands.remove(hostile, true),
            sudoCommands.rename(hostile, '/tmp/b'),
            sudoCommands.chmod(hostile, '755'),
            sudoCommands.chown(hostile, 'root', 'root'),
            sudoCommands.read(hostile),
        ]) {
            const output = execFileSync('/bin/sh', ['-c', `set -- ${command}; printf '%s\\0' "$@"`], {
                encoding: 'utf-8',
            });
            const argv = output.split('\0').slice(0, -1);

            assert.ok(!output.includes('INJECTED\n'), `payload executed for: ${command}`);
            assert.ok(argv.includes(hostile), `path was mangled for: ${command}`);
        }
    });

    test('uses -- so a leading dash is not read as a flag', () => {
        assert.match(sudoCommands.remove('/tmp/-rf', false), /-- /);
        assert.match(sudoCommands.rename('/tmp/-a', '/tmp/-b'), /-- /);
    });

    test('recurses only for directories', () => {
        assert.match(sudoCommands.remove('/tmp/dir', true), /^rm -rf /);
        assert.match(sudoCommands.remove('/tmp/file', false), /^rm -f /);
    });
});

/** A fake exec channel that records what was written to it. */
class FakeStream extends EventEmitter {
    readonly stderr = new EventEmitter();
    readonly written: Buffer[] = [];
    write(chunk: string | Buffer): void {
        this.written.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    end(): void {}
    body(): string {
        return Buffer.concat(this.written).toString();
    }
}

function fakeClient(behaviour: (command: string, stream: FakeStream) => void) {
    const commands: string[] = [];
    const streams: FakeStream[] = [];

    const client = {
        exec(command: string, callback: (err: Error | undefined, stream: FakeStream) => void) {
            commands.push(command);
            const stream = new FakeStream();
            streams.push(stream);
            callback(undefined, stream);
            setImmediate(() => behaviour(command, stream));
            return true;
        },
    } as unknown as Client;

    return { client, commands, streams };
}

suite('privilege: running a sudo command', () => {
    test('passes the password on stdin, never in the command line', async () => {
        // A password in argv would be visible to every user on the host.
        const { client, commands, streams } = fakeClient((_command, stream) => {
            stream.emit('data', Buffer.from('ok'));
            stream.emit('close', 0);
        });

        const escalation = new PrivilegeEscalation(
            () => client,
            () => 'me@host'
        );
        (escalation as unknown as { password: string }).password = 's3cret';

        const result = await escalation.run('rm -f /tmp/x');

        assert.strictEqual(result.stdout.toString(), 'ok');
        assert.ok(!commands[0].includes('s3cret'), 'password leaked into the command line');
        assert.ok(streams[0].body().startsWith('s3cret\n'), 'password not written first on stdin');
    });

    test('silences the sudo prompt so it cannot pollute output', async () => {
        const { client, commands } = fakeClient((_command, stream) => stream.emit('close', 0));
        const escalation = new PrivilegeEscalation(
            () => client,
            () => 'me@host'
        );
        (escalation as unknown as { password: string }).password = 'pw';

        await escalation.run('true');

        assert.match(commands[0], /sudo -S -p ''/);
    });

    test('sends payload data after the password', async () => {
        const { client, streams } = fakeClient((_command, stream) => stream.emit('close', 0));
        const escalation = new PrivilegeEscalation(
            () => client,
            () => 'me@host'
        );
        (escalation as unknown as { password: string }).password = 'pw';

        await escalation.run('cat > /tmp/x', Buffer.from('file body'));

        assert.strictEqual(streams[0].body(), 'pw\nfile body');
    });

    test('runOrThrow surfaces stderr when the command fails', async () => {
        const { client } = fakeClient((_command, stream) => {
            stream.stderr.emit('data', Buffer.from('rm: cannot remove'));
            stream.emit('close', 1);
        });

        const escalation = new PrivilegeEscalation(
            () => client,
            () => 'me@host'
        );
        (escalation as unknown as { password: string }).password = 'pw';

        await assert.rejects(escalation.runOrThrow('rm -f /x'), /cannot remove/);
    });

    test('runOrThrow returns stdout on success', async () => {
        const { client } = fakeClient((_command, stream) => {
            stream.emit('data', Buffer.from('contents'));
            stream.emit('close', 0);
        });

        const escalation = new PrivilegeEscalation(
            () => client,
            () => 'me@host'
        );
        (escalation as unknown as { password: string }).password = 'pw';

        assert.strictEqual((await escalation.runOrThrow('cat /x')).toString(), 'contents');
    });

    test('forgets a rejected password instead of reusing it', async () => {
        const { client } = fakeClient((_command, stream) => {
            stream.stderr.emit('data', Buffer.from('sudo: Sorry, try again.'));
            stream.emit('close', 1);
        });

        const escalation = new PrivilegeEscalation(
            () => client,
            () => 'me@host'
        );
        (escalation as unknown as { password: string }).password = 'wrong';

        // The retry prompts for a new password; nobody is there to answer, so
        // the prompt is stubbed to decline.
        const original = vscode.window.showInputBox;
        let prompted = 0;
        (vscode.window as { showInputBox: unknown }).showInputBox = async () => {
            prompted++;
            return undefined;
        };

        try {
            await assert.rejects(escalation.run('true'), /cancelled/i);
        } finally {
            (vscode.window as { showInputBox: unknown }).showInputBox = original;
        }

        assert.strictEqual(prompted, 1, 'the rejected password should not be reused silently');
        assert.strictEqual((escalation as unknown as { password?: string }).password, undefined);
    });

    test('fails clearly when there is no connection', async () => {
        const escalation = new PrivilegeEscalation(
            () => undefined,
            () => 'me@host'
        );

        await assert.rejects(escalation.run('true'), /not established/);
    });

    test('forget clears the cached password', () => {
        const escalation = new PrivilegeEscalation(
            () => undefined,
            () => 'me@host'
        );
        (escalation as unknown as { password: string }).password = 'pw';

        escalation.forget();

        assert.strictEqual((escalation as unknown as { password?: string }).password, undefined);
    });
});
