import * as assert from 'assert';
import * as net from 'net';
import { Client, Server, utils } from 'ssh2';
import { runOnHost, runOnHosts } from '../multiCommandRun';

/**
 * Exercises the real exec path.
 *
 * Exit status, stderr and a channel that dies all arrive through ssh2's own
 * events, so a stub client would prove nothing about them.
 */

/** How the fake server should answer one exec request. */
interface Reply {
    stdout?: string;
    stderr?: string;
    code?: number;
    /** Close the channel without an exit status. */
    vanish?: boolean;
    /** Refuse the session outright. */
    refuse?: boolean;
}

interface Harness {
    client: Client;
    close: () => Promise<void>;
}

async function sshHarness(reply: (command: string) => Reply): Promise<Harness> {
    const hostKey = utils.generateKeyPairSync('ed25519');

    const server = new Server({ hostKeys: [hostKey.private] }, connection => {
        connection.on('authentication', ctx => ctx.accept());
        connection.on('error', () => undefined);

        connection.on('session', accept => {
            const session = accept();
            session.on('exec', (acceptExec, rejectExec, info) => {
                const answer = reply(info.command);
                if (answer.refuse) {
                    rejectExec();
                    return;
                }

                const channel = acceptExec();
                if (answer.stdout) {
                    channel.write(answer.stdout);
                }
                if (answer.stderr) {
                    channel.stderr.write(answer.stderr);
                }

                if (answer.vanish) {
                    channel.close();
                    return;
                }

                channel.exit(answer.code ?? 0);
                channel.end();
            });
        });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;

    const client = new Client();
    await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', reject);
        client.connect({ host: '127.0.0.1', port, username: 'test', password: 'test' });
    });

    return {
        client,
        close: () =>
            new Promise<void>(done => {
                client.end();
                server.close(() => done());
            }),
    };
}

suite('runOnHost', () => {
    test('collects stdout and a zero exit', async () => {
        const harness = await sshHarness(() => ({ stdout: 'up 3 days\n' }));

        try {
            const result = await runOnHost({ host: 'a', client: harness.client }, 'uptime');

            assert.deepStrictEqual(result, { host: 'a', stdout: 'up 3 days\n', stderr: '', code: 0 });
        } finally {
            await harness.close();
        }
    });

    test('keeps stderr apart from stdout, with the failing status', async () => {
        const harness = await sshHarness(() => ({ stderr: 'no such file\n', code: 2 }));

        try {
            const result = await runOnHost({ host: 'a', client: harness.client }, 'ls /nope');

            assert.strictEqual(result.stdout, '');
            assert.strictEqual(result.stderr, 'no such file\n');
            assert.strictEqual(result.code, 2);
            assert.strictEqual(result.error, undefined);
        } finally {
            await harness.close();
        }
    });

    test('reports a channel that closed without a status rather than claiming success', async () => {
        const harness = await sshHarness(() => ({ stdout: 'partial', vanish: true }));

        try {
            const result = await runOnHost({ host: 'a', client: harness.client }, 'sleep 1');

            assert.strictEqual(result.code, undefined);
            assert.ok(result.error);
        } finally {
            await harness.close();
        }
    });

    test('a host that refuses the command does not reject, so the others still report', async () => {
        const harness = await sshHarness(command => (command === 'bad' ? { refuse: true } : { stdout: 'fine' }));

        try {
            const [refused, fine] = await Promise.all([
                runOnHost({ host: 'a', client: harness.client }, 'bad'),
                runOnHost({ host: 'b', client: harness.client }, 'good'),
            ]);

            assert.ok(refused.error);
            assert.strictEqual(fine.stdout, 'fine');
        } finally {
            await harness.close();
        }
    });

    test('sends the command through unchanged', async () => {
        const seen: string[] = [];
        const harness = await sshHarness(command => {
            seen.push(command);
            return { stdout: '' };
        });

        try {
            await runOnHost({ host: 'a', client: harness.client }, "echo 'it worked' | tr a-z A-Z");

            assert.deepStrictEqual(seen, ["echo 'it worked' | tr a-z A-Z"]);
        } finally {
            await harness.close();
        }
    });
});

suite('runOnHosts', () => {
    test('returns results in the order the hosts were given, and reports each as it lands', async () => {
        const harness = await sshHarness(command => ({ stdout: command }));

        try {
            const finished: string[] = [];
            const targets = ['a', 'b', 'c'].map(host => ({ host, client: harness.client }));

            const results = await runOnHosts(targets, 'hostname', result => finished.push(result.host));

            assert.deepStrictEqual(
                results.map(result => result.host),
                ['a', 'b', 'c']
            );
            assert.strictEqual(finished.length, 3);
        } finally {
            await harness.close();
        }
    });
});
