import * as assert from 'assert';
import * as net from 'net';
import { Client, Server, utils } from 'ssh2';
import { openJumpChain, resolveHop, HopTarget } from '../proxyChain';
import { SSHConnection } from '../utils/sshConfig';

/**
 * Exercises a real jump chain.
 *
 * Every hop is a genuine ssh2 server, and every link between them is a real
 * `direct-tcpip` channel, so this proves the chain actually carries an SSH
 * session rather than that the calls were made in the right order.
 */

interface Hop {
    port: number;
    /** Destinations this hop was asked to open a channel to. */
    requested: { host: string; port: number }[];
    /** Usernames that authenticated against it. */
    users: string[];
    close: () => Promise<void>;
}

/** Starts an ssh2 server that forwards direct-tcpip requests for real. */
async function bastion(): Promise<Hop> {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const requested: { host: string; port: number }[] = [];
    const users: string[] = [];
    const sockets = new Set<net.Socket>();

    const server = new Server({ hostKeys: [hostKey.private] }, connection => {
        connection.on('authentication', ctx => {
            users.push(ctx.username);
            ctx.accept();
        });
        connection.on('error', () => undefined);

        connection.on('tcpip', (accept, reject, info) => {
            requested.push({ host: info.destIP, port: info.destPort });

            // Accepted only once the far side answers, as a real server does:
            // a channel to a dead port must fail rather than open and hang.
            const upstream = net.connect(info.destPort, info.destIP, () => {
                const channel = accept();
                channel.pipe(upstream).pipe(channel);
                upstream.on('error', () => channel.close());
            });
            sockets.add(upstream);
            upstream.on('close', () => sockets.delete(upstream));
            upstream.once('error', () => reject());
        });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    return {
        port: (server.address() as net.AddressInfo).port,
        requested,
        users,
        close: () =>
            new Promise<void>(done => {
                sockets.forEach(socket => socket.destroy());
                server.close(() => done());
            }),
    };
}

/** A port nothing is listening on. */
async function deadPort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    return port;
}

const noConfig = () => null;
const anyPassword = async () => ({ password: 'unused-by-the-test-server' });
const acceptKey = async () => true;

suite('proxyChain: resolving a hop', () => {
    const config = (overrides: Partial<SSHConnection>): SSHConnection => ({
        host: 'bastion',
        hostname: '10.0.0.1',
        ...overrides,
    });

    test('prefers what the directive says over the host block', () => {
        const target = resolveHop({ host: 'bastion', user: 'jump', port: 2222 }, () =>
            config({ user: 'other', port: 2022 })
        );

        assert.deepStrictEqual(target, { host: '10.0.0.1', port: 2222, username: 'jump' });
    });

    test('falls back to the host block', () => {
        const target = resolveHop({ host: 'bastion' }, () => config({ user: 'other', port: 2022 }));

        assert.deepStrictEqual(target, { host: '10.0.0.1', port: 2022, username: 'other' });
    });

    test('uses the alias itself when there is no host block', () => {
        const target = resolveHop({ host: 'bastion.example', user: 'me' }, noConfig);

        assert.deepStrictEqual(target, { host: 'bastion.example', port: 22, username: 'me' });
    });
});

suite('proxyChain: opening a chain', () => {
    test('carries a real SSH session through one bastion', async () => {
        const hop = await bastion();
        const target = await bastion();

        const chain = await openJumpChain(
            [{ host: 'bastion', user: 'jumper' }],
            { host: '127.0.0.1', port: target.port },
            () => ({ host: 'bastion', hostname: '127.0.0.1', port: hop.port }),
            anyPassword,
            acceptKey
        );

        try {
            // The channel is only proven by speaking SSH over it.
            const client = new Client();
            await new Promise<void>((resolve, reject) => {
                client.once('ready', resolve);
                client.once('error', reject);
                client.connect({
                    sock: chain.sock,
                    username: 'final',
                    password: 'x',
                    hostVerifier: () => true,
                });
            });
            client.end();

            assert.deepStrictEqual(hop.requested, [{ host: '127.0.0.1', port: target.port }]);
            assert.deepStrictEqual(hop.users, ['jumper']);
            assert.deepStrictEqual(target.users, ['final']);
        } finally {
            chain.dispose();
            await hop.close();
            await target.close();
        }
    });

    test('traverses two bastions in order', async () => {
        const first = await bastion();
        const second = await bastion();
        const target = await bastion();

        const blocks: Record<string, SSHConnection> = {
            first: { host: 'first', hostname: '127.0.0.1', port: first.port },
            second: { host: 'second', hostname: '127.0.0.1', port: second.port },
        };

        const chain = await openJumpChain(
            [{ host: 'first' }, { host: 'second' }],
            { host: '127.0.0.1', port: target.port },
            alias => blocks[alias] ?? null,
            anyPassword,
            acceptKey
        );

        try {
            assert.strictEqual(chain.description, 'first -> second');
            // The first hop reaches the second, and the second the target.
            assert.deepStrictEqual(first.requested, [{ host: '127.0.0.1', port: second.port }]);
            assert.deepStrictEqual(second.requested, [{ host: '127.0.0.1', port: target.port }]);
        } finally {
            chain.dispose();
            await first.close();
            await second.close();
            await target.close();
        }
    });

    test('checks the host key of every hop', async () => {
        const hop = await bastion();
        const target = await bastion();
        const checked: HopTarget[] = [];

        const chain = await openJumpChain(
            [{ host: 'bastion', user: 'jumper' }],
            { host: '127.0.0.1', port: target.port },
            () => ({ host: 'bastion', hostname: '127.0.0.1', port: hop.port }),
            anyPassword,
            async hopTarget => {
                checked.push(hopTarget);
                return true;
            }
        );

        try {
            assert.deepStrictEqual(checked, [{ host: '127.0.0.1', port: hop.port, username: 'jumper' }]);
        } finally {
            chain.dispose();
            await hop.close();
            await target.close();
        }
    });

    test('refuses to connect when the host key is rejected', async () => {
        const hop = await bastion();

        await assert.rejects(
            openJumpChain(
                [{ host: 'bastion' }],
                { host: '127.0.0.1', port: 22 },
                () => ({ host: 'bastion', hostname: '127.0.0.1', port: hop.port }),
                anyPassword,
                async () => false
            )
        );

        await hop.close();
    });

    test('names the hop that could not be reached', async () => {
        const port = await deadPort();

        await assert.rejects(
            openJumpChain(
                [{ host: 'bastion' }],
                { host: '127.0.0.1', port: 22 },
                () => ({ host: 'bastion', hostname: '127.0.0.1', port }),
                anyPassword,
                acceptKey
            ),
            /Jump host 127\.0\.0\.1:/
        );
    });

    test('names the hop that could not reach the next one', async () => {
        const hop = await bastion();
        const port = await deadPort();

        await assert.rejects(
            openJumpChain(
                [{ host: 'bastion' }],
                { host: '127.0.0.1', port },
                () => ({ host: 'bastion', hostname: '127.0.0.1', port: hop.port }),
                anyPassword,
                acceptKey
            ),
            new RegExp(`could not reach 127\\.0\\.0\\.1:${port}`)
        );

        await hop.close();
    });

    test('tells the credential prompt which hop is asking', async () => {
        const first = await bastion();
        const second = await bastion();
        const target = await bastion();
        const asked: string[] = [];

        const blocks: Record<string, SSHConnection> = {
            first: { host: 'first', hostname: '127.0.0.1', port: first.port },
            second: { host: 'second', hostname: '127.0.0.1', port: second.port },
        };

        const chain = await openJumpChain(
            [{ host: 'first' }, { host: 'second' }],
            { host: '127.0.0.1', port: target.port },
            alias => blocks[alias] ?? null,
            async (hop, _target, position) => {
                asked.push(`${hop.host} ${position.index + 1}/${position.total}`);
                return { password: 'unused-by-the-test-server' };
            },
            acceptKey
        );

        try {
            assert.deepStrictEqual(asked, ['first 1/2', 'second 2/2']);
        } finally {
            chain.dispose();
            await first.close();
            await second.close();
            await target.close();
        }
    });

    test('rejects an empty chain rather than connecting directly', async () => {
        await assert.rejects(
            openJumpChain([], { host: 'h', port: 22 }, noConfig, anyPassword, acceptKey),
            /at least one host/
        );
    });
});
