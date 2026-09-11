import * as assert from 'assert';
import * as net from 'net';
import { Client, Server, utils } from 'ssh2';
import { TunnelManager } from '../tunnels';
import { TunnelConfig, LOOPBACK } from '../utils/tunnelModel';

/**
 * Exercises the real ssh2 forwarding path.
 *
 * Every other tunnel test substitutes the SSH client, which proves the
 * plumbing but not that we drive ssh2 correctly. Here a genuine ssh2 server
 * and client are used, so `forwardOut` and `forwardIn` do the real work.
 */

function config(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
    return {
        id: 't1',
        kind: 'local',
        bindAddress: LOOPBACK,
        listenPort: 0,
        destinationHost: 'echo.internal',
        destinationPort: 1234,
        ...overrides,
    };
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, LOOPBACK, () => {
            const { port } = probe.address() as net.AddressInfo;
            probe.close(() => resolve(port));
        });
    });
}

function echoServer(): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise(resolve => {
        const server = net.createServer(socket => socket.pipe(socket));
        server.listen(0, LOOPBACK, () => {
            const { port } = server.address() as net.AddressInfo;
            resolve({ port, close: () => new Promise<void>(done => server.close(() => done())) });
        });
    });
}

interface Harness {
    client: Client;
    /** Destinations the server was asked to reach. */
    requested: { host: string; port: number }[];
    close: () => Promise<void>;
}

/**
 * Starts an ssh2 server and a client connected to it.
 *
 * @param onTcpip How the server should handle a direct-tcpip request.
 */
async function sshHarness(
    onTcpip: (info: { destIP: string; destPort: number }) => { echoTo?: number; refuse?: boolean }
): Promise<Harness> {
    const hostKey = utils.generateKeyPairSync('ed25519');
    const requested: { host: string; port: number }[] = [];
    const openSockets = new Set<net.Socket>();

    const server = new Server({ hostKeys: [hostKey.private] }, connection => {
        connection.on('authentication', ctx => ctx.accept());
        connection.on('ready', () => undefined);

        connection.on('tcpip', (accept, reject, info) => {
            requested.push({ host: info.destIP, port: info.destPort });
            const decision = onTcpip(info);

            if (decision.refuse || decision.echoTo === undefined) {
                reject();
                return;
            }

            const channel = accept();
            const upstream = net.connect(decision.echoTo, LOOPBACK, () => channel.pipe(upstream).pipe(channel));
            openSockets.add(upstream);
            upstream.on('close', () => openSockets.delete(upstream));
            upstream.on('error', () => channel.close());
        });
    });

    const port = await freePort();
    await new Promise<void>(resolve => server.listen(port, LOOPBACK, resolve));

    const client = new Client();
    await new Promise<void>((resolve, reject) => {
        client.on('ready', resolve);
        client.on('error', reject);
        client.connect({ host: LOOPBACK, port, username: 'tester', password: 'x' });
    });

    return {
        client,
        requested,
        close: async () => {
            for (const socket of openSockets) {
                socket.destroy();
            }
            client.end();
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}

suite('tunnels: real ssh2 local forward', () => {
    test('carries traffic through an actual SSH connection', async function () {
        this.timeout(15000);

        const echo = await echoServer();
        const harness = await sshHarness(() => ({ echoTo: echo.port }));
        const listenPort = await freePort();
        const manager = new TunnelManager(() => harness.client);

        const entry = await manager.add(
            'web',
            config({ listenPort, destinationHost: 'echo.internal', destinationPort: 1234 })
        );
        assert.strictEqual(entry?.state, 'active', entry?.error);

        const reply = await new Promise<string>((resolve, reject) => {
            const socket = net.connect(listenPort, LOOPBACK, () => socket.write('hello over ssh'));
            socket.on('data', data => {
                resolve(data.toString());
                socket.end();
            });
            socket.on('error', reject);
        });

        assert.strictEqual(reply, 'hello over ssh');
        // The destination is resolved by the server, so it must arrive
        // untouched rather than being connected to locally.
        assert.deepStrictEqual(harness.requested, [{ host: 'echo.internal', port: 1234 }]);
        assert.strictEqual(manager.list('web')[0].connectionCount, 1);
        assert.strictEqual(manager.list('web')[0].lastError, undefined);

        await manager.disposeConnection('web');
        manager.dispose();
        await harness.close();
        await echo.close();
    });

    test('reports a forward the server refuses', async function () {
        this.timeout(15000);

        // What `AllowTcpForwarding no` looks like from the client side.
        const harness = await sshHarness(() => ({ refuse: true }));
        const listenPort = await freePort();
        const manager = new TunnelManager(() => harness.client);

        await manager.add('web', config({ listenPort }));

        await new Promise<void>(resolve => {
            const socket = net.connect(listenPort, LOOPBACK, () => socket.write('ping'));
            socket.on('close', () => resolve());
            socket.on('error', () => resolve());
        });

        const tunnel = manager.list('web')[0];
        assert.ok(tunnel.lastError, 'a refused forward must be reported, not swallowed');
        assert.strictEqual(tunnel.connectionCount, 0);

        await manager.disposeConnection('web');
        manager.dispose();
        await harness.close();
    });
});
