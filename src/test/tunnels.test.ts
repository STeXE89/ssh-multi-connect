import * as assert from 'assert';
import * as net from 'net';
import type { Client } from 'ssh2';
import { TunnelManager, explainListenFailure, explainForwardInFailure, explainForwardFailure } from '../tunnels';
import {
    parsePort,
    validatePort,
    validateHost,
    tunnelLabel,
    tunnelFlag,
    describeTunnel,
    conflictsWith,
    TunnelConfig,
    LOOPBACK,
} from '../utils/tunnelModel';

function config(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
    return {
        id: 't1',
        kind: 'local',
        bindAddress: LOOPBACK,
        listenPort: 8080,
        destinationHost: 'db',
        destinationPort: 5432,
        ...overrides,
    };
}

suite('tunnels: port parsing', () => {
    test('accepts ports in range', () => {
        assert.strictEqual(parsePort('22'), 22);
        assert.strictEqual(parsePort('65535'), 65535);
        assert.strictEqual(parsePort('  8080 '), 8080);
    });

    test('rejects out-of-range and non-numeric input', () => {
        assert.strictEqual(parsePort('0'), undefined);
        assert.strictEqual(parsePort('65536'), undefined);
        assert.strictEqual(parsePort('-1'), undefined);
        assert.strictEqual(parsePort('80a'), undefined);
        assert.strictEqual(parsePort(''), undefined);
    });

    test('allows zero only when asked', () => {
        assert.strictEqual(parsePort('0', true), 0);
        assert.strictEqual(parsePort('0', false), undefined);
    });

    test('validatePort explains the range', () => {
        assert.match(validatePort('nope') ?? '', /between 1 and 65535/);
        assert.strictEqual(validatePort('443'), undefined);
    });
});

suite('tunnels: host validation', () => {
    test('accepts names, addresses and bracketed IPv6', () => {
        for (const host of ['localhost', 'db.internal', '10.0.0.5', '[::1]']) {
            assert.strictEqual(validateHost(host), undefined, host);
        }
    });

    test('rejects empty input and shell metacharacters', () => {
        assert.match(validateHost('') ?? '', /required/);
        assert.ok(validateHost('db; rm -rf /'));
        assert.ok(validateHost('db$(id)'));
    });
});

suite('tunnels: labels', () => {
    test('reads in the direction traffic travels', () => {
        assert.strictEqual(tunnelLabel(config()), '127.0.0.1:8080 -> db:5432');
    });

    test('shows the equivalent ssh flag', () => {
        assert.strictEqual(tunnelFlag(config()), '-L 127.0.0.1:8080:db:5432');
        assert.strictEqual(tunnelFlag(config({ kind: 'remote' })), '-R 127.0.0.1:8080:db:5432');
    });

    test('describes a local forward from the right side', () => {
        const text = describeTunnel(config(), 'web');

        assert.match(text, /Local forward/);
        assert.match(text, /on this machine/);
        assert.match(text, /as seen from web/);
    });

    test('describes a remote forward from the right side', () => {
        const text = describeTunnel(config({ kind: 'remote' }), 'web');

        assert.match(text, /Remote forward/);
        assert.match(text, /on web/);
        assert.match(text, /from this machine/);
    });
});

suite('tunnels: conflicts', () => {
    test('two tunnels on the same address and port collide', () => {
        assert.strictEqual(conflictsWith(config(), config({ id: 't2' })), true);
    });

    test('a different port does not collide', () => {
        assert.strictEqual(conflictsWith(config(), config({ id: 't2', listenPort: 9090 })), false);
    });

    test('a different bind address does not collide', () => {
        assert.strictEqual(conflictsWith(config(), config({ id: 't2', bindAddress: '0.0.0.0' })), false);
    });

    test('local and remote forwards on the same port do not collide', () => {
        // They listen on opposite ends of the connection.
        assert.strictEqual(conflictsWith(config(), config({ id: 't2', kind: 'remote' })), false);
    });

    test('the destination is irrelevant to a conflict', () => {
        assert.strictEqual(
            conflictsWith(config(), config({ id: 't2', destinationHost: 'other', destinationPort: 1 })),
            true
        );
    });
});

/** Reserves a free TCP port by opening and immediately closing a listener. */
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

/** Starts a server that echoes back whatever it receives. */
function echoServer(): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise(resolve => {
        const server = net.createServer(socket => socket.pipe(socket));
        server.listen(0, LOOPBACK, () => {
            const { port } = server.address() as net.AddressInfo;
            resolve({
                port,
                close: () => new Promise<void>(done => server.close(() => done())),
            });
        });
    });
}

/**
 * A stand-in for an ssh2 client whose forwardOut lands on a local server,
 * which is enough to exercise the plumbing without an SSH session.
 */
function fakeForwardingClient(targetPort: number) {
    const opened: { host: string; port: number }[] = [];
    // In production these are ssh2 channels, closed with the SSH client. Here
    // they are real sockets, so the fake has to close them itself or the echo
    // server never finishes shutting down.
    const upstreams = new Set<net.Socket>();

    const client = {
        forwardOut(
            _srcIp: string,
            _srcPort: number,
            dstHost: string,
            dstPort: number,
            callback: (err: Error | undefined, stream: net.Socket) => void
        ) {
            opened.push({ host: dstHost, port: dstPort });
            const upstream = net.connect(targetPort, LOOPBACK, () => callback(undefined, upstream));
            upstreams.add(upstream);
            upstream.on('close', () => upstreams.delete(upstream));
            upstream.on('error', error => callback(error as Error, upstream));
        },
    } as unknown as Client;

    return {
        client,
        opened,
        closeAll: () => {
            for (const upstream of upstreams) {
                upstream.destroy();
            }
            upstreams.clear();
        },
    };
}

suite('tunnels: manager bookkeeping', () => {
    test('reports an error when there is no connection', async () => {
        const manager = new TunnelManager(() => undefined);

        const entry = await manager.add('web', config());

        assert.strictEqual(entry?.state, 'error');
        assert.match(entry?.error ?? '', /not established/);
        manager.dispose();
    });

    test('refuses a tunnel that would clash with an existing one', async () => {
        const manager = new TunnelManager(() => undefined);
        await manager.add('web', config({ id: 't1' }));

        assert.strictEqual(await manager.add('web', config({ id: 't2' })), undefined);
        assert.strictEqual(manager.list('web').length, 1);
        manager.dispose();
    });

    test("keeps each connection's tunnels apart", async () => {
        const manager = new TunnelManager(() => undefined);

        await manager.add('web', config({ id: 't1' }));
        await manager.add('db', config({ id: 't2' }));

        assert.strictEqual(manager.list('web').length, 1);
        assert.strictEqual(manager.list('db').length, 1);
        manager.dispose();
    });

    test('removing drops the tunnel from the list', async () => {
        const manager = new TunnelManager(() => undefined);
        await manager.add('web', config({ id: 't1' }));

        await manager.remove('web', 't1');

        assert.deepStrictEqual(manager.list('web'), []);
        manager.dispose();
    });

    test('closing a connection forgets its tunnels', async () => {
        // A tunnel cannot outlive the SSH session that carries it.
        const manager = new TunnelManager(() => undefined);
        await manager.add('web', config({ id: 't1' }));

        await manager.disposeConnection('web');

        assert.deepStrictEqual(manager.list('web'), []);
        manager.dispose();
    });

    test('announces every change', async () => {
        const manager = new TunnelManager(() => undefined);
        const seen: string[] = [];
        manager.onDidChange(id => seen.push(id));

        await manager.add('web', config({ id: 't1' }));
        await manager.remove('web', 't1');

        assert.ok(seen.length >= 2);
        assert.ok(seen.every(id => id === 'web'));
        manager.dispose();
    });
});

suite('tunnels: a local forward carries traffic', () => {
    test('data sent to the local port comes back from the far side', async () => {
        const echo = await echoServer();
        const listenPort = await freePort();
        const { client, opened, closeAll } = fakeForwardingClient(echo.port);
        const manager = new TunnelManager(() => client);

        const entry = await manager.add(
            'web',
            config({ listenPort, destinationHost: 'db.internal', destinationPort: 5432 })
        );
        assert.strictEqual(entry?.state, 'active', entry?.error);

        const reply = await new Promise<string>((resolve, reject) => {
            const socket = net.connect(listenPort, LOOPBACK, () => socket.write('ping'));
            socket.on('data', data => {
                resolve(data.toString());
                socket.end();
            });
            socket.on('error', reject);
        });

        assert.strictEqual(reply, 'ping');
        // The destination is resolved on the far side, so it is passed through
        // untouched rather than being connected to locally.
        assert.deepStrictEqual(opened, [{ host: 'db.internal', port: 5432 }]);
        assert.strictEqual(manager.list('web')[0].connectionCount, 1);

        await manager.disposeConnection('web');
        closeAll();
        await echo.close();
        manager.dispose();
    });

    test('stopping closes the listener', async () => {
        const echo = await echoServer();
        const listenPort = await freePort();
        const { client, closeAll } = fakeForwardingClient(echo.port);
        const manager = new TunnelManager(() => client);
        await manager.add('web', config({ listenPort }));

        await manager.stop('web', 't1');

        assert.strictEqual(manager.list('web')[0].state, 'stopped');
        await assert.rejects(
            new Promise((resolve, reject) => {
                const socket = net.connect(listenPort, LOOPBACK, () => resolve(undefined));
                socket.on('error', reject);
            })
        );

        closeAll();
        await echo.close();
        manager.dispose();
    });

    test('a port already in use is reported as an error', async () => {
        const echo = await echoServer();
        const { client } = fakeForwardingClient(echo.port);
        const manager = new TunnelManager(() => client);

        // echo.port is taken, so binding it must fail rather than throw.
        const entry = await manager.add('web', config({ listenPort: echo.port }));

        assert.strictEqual(entry?.state, 'error');
        assert.match(entry?.error ?? '', /already in use/i);

        await echo.close();
        manager.dispose();
    });

    test('a stopped tunnel can be started again', async () => {
        const echo = await echoServer();
        const listenPort = await freePort();
        const { client, closeAll } = fakeForwardingClient(echo.port);
        const manager = new TunnelManager(() => client);
        await manager.add('web', config({ listenPort }));

        await manager.stop('web', 't1');
        await manager.start('web', 't1');

        assert.strictEqual(manager.list('web')[0].state, 'active');

        await manager.disposeConnection('web');
        closeAll();
        await echo.close();
        manager.dispose();
    });
});

/** A fake client whose forwardOut always refuses, as a locked-down sshd would. */
function refusingClient(reason: string) {
    const client = {
        forwardOut(
            _srcIp: string,
            _srcPort: number,
            _dstHost: string,
            _dstPort: number,
            callback: (err: Error | undefined, stream?: net.Socket) => void
        ) {
            callback(new Error(reason));
        },
    } as unknown as Client;

    return client;
}

suite('tunnels: a refused forward is reported', () => {
    test('records why the connection could not be forwarded', async () => {
        // A listener opens fine even when the server refuses forwarding, e.g.
        // `AllowTcpForwarding no`. Dropping the socket silently made the
        // tunnel look healthy while nothing ever got through.
        const listenPort = await freePort();
        const manager = new TunnelManager(() => refusingClient('open failed: administratively prohibited'));

        const entry = await manager.add('web', config({ listenPort }));
        assert.strictEqual(entry?.state, 'active');

        await new Promise<void>(resolve => {
            const socket = net.connect(listenPort, LOOPBACK, () => socket.write('ping'));
            socket.on('close', () => resolve());
            socket.on('error', () => resolve());
        });

        const tunnel = manager.list('web')[0];
        assert.match(tunnel.lastError ?? '', /administratively prohibited/);
        assert.strictEqual(tunnel.connectionCount, 0, 'a refused forward must not count as carried');

        await manager.disposeConnection('web');
        manager.dispose();
    });

    test('a working tunnel reports no failure', async () => {
        const echo = await echoServer();
        const listenPort = await freePort();
        const { client, closeAll } = fakeForwardingClient(echo.port);
        const manager = new TunnelManager(() => client);
        await manager.add('web', config({ listenPort }));

        await new Promise<void>((resolve, reject) => {
            const socket = net.connect(listenPort, LOOPBACK, () => socket.write('ping'));
            socket.on('data', () => {
                socket.end();
                resolve();
            });
            socket.on('error', reject);
        });

        assert.strictEqual(manager.list('web')[0].lastError, undefined);

        await manager.disposeConnection('web');
        closeAll();
        await echo.close();
        manager.dispose();
    });

    test('restarting clears a previous failure', async () => {
        const listenPort = await freePort();
        const manager = new TunnelManager(() => refusingClient('refused'));
        await manager.add('web', config({ listenPort }));

        await new Promise<void>(resolve => {
            const socket = net.connect(listenPort, LOOPBACK, () => socket.write('x'));
            socket.on('close', () => resolve());
            socket.on('error', () => resolve());
        });
        assert.ok(manager.list('web')[0].lastError);

        await manager.stop('web', 't1');
        await manager.start('web', 't1');

        assert.strictEqual(manager.list('web')[0].lastError, undefined);

        await manager.disposeConnection('web');
        manager.dispose();
    });
});

/** Builds an error shaped like the ones Node reports from listen(). */
function errno(code: string, message = code): NodeJS.ErrnoException {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

suite('tunnels: start failures explain themselves', () => {
    test('a port already in use names the port and the remedy', async () => {
        const echo = await echoServer();
        const manager = new TunnelManager(() => refusingClient('unused'));

        const entry = await manager.add('web', config({ listenPort: echo.port }));

        assert.strictEqual(entry?.state, 'error');
        assert.match(entry?.error ?? '', new RegExp(`Port ${echo.port} is already in use`));
        assert.match(entry?.error ?? '', /Choose another local port/);

        await echo.close();
        manager.dispose();
    });

    test('a privileged port explains the permission rule', () => {
        // Not driven through a real bind: some systems allow low ports
        // outright (ip_unprivileged_port_start=0), so the mapping is what
        // matters, not this machine's policy.
        const message = explainListenFailure(errno('EACCES'), LOOPBACK, 80);

        assert.match(message, /below 1024 need elevated privileges/);
        assert.match(message, /127\.0\.0\.1:80/);
    });

    test('an address this machine does not have is named', () => {
        const message = explainListenFailure(errno('EADDRNOTAVAIL'), '10.255.255.1', 8080);

        assert.match(message, /10\.255\.255\.1 is not an address on this machine/);
    });

    test('an unrecognised failure still reports the original message', () => {
        const message = explainListenFailure(errno('EPIPE', 'socket hang up'), LOOPBACK, 8080);

        assert.match(message, /socket hang up/);
        assert.match(message, /127\.0\.0\.1:8080/);
    });

    test('a prohibited remote listener names the two server settings', () => {
        const message = explainForwardInFailure(new Error('administratively prohibited'), '0.0.0.0', 9090);

        assert.match(message, /AllowTcpForwarding yes/);
        assert.match(message, /GatewayPorts yes/);
    });

    test('another remote listener failure suggests the usual causes', () => {
        const message = explainForwardInFailure(new Error('port in use'), LOOPBACK, 9090);

        assert.match(message, /port in use/);
        assert.match(message, /GatewayPorts yes/);
    });

    test('a forward the server prohibits points at AllowTcpForwarding', async () => {
        const listenPort = await freePort();
        const manager = new TunnelManager(() => refusingClient('Channel open failure: administratively prohibited'));
        await manager.add('web', config({ listenPort }));

        await new Promise<void>(resolve => {
            const socket = net.connect(listenPort, LOOPBACK, () => socket.write('x'));
            socket.on('close', () => resolve());
            socket.on('error', () => resolve());
        });

        assert.match(manager.list('web')[0].lastError ?? '', /AllowTcpForwarding/);

        await manager.disposeConnection('web');
        manager.dispose();
    });
});

suite('tunnels: a refusal points at the far side', () => {
    test('connection refused names the destination, not the local port', () => {
        // The local listener is ours and is working; the problem is remote.
        const message = explainForwardFailure('(SSH) Channel open failure: Connection refused', config());

        assert.match(message, /Nothing is listening on db:5432/);
        assert.match(message, /far end/);
        assert.ok(!message.includes('8080'), 'must not blame the local port');
    });

    test('a prohibited channel still points at AllowTcpForwarding', () => {
        const message = explainForwardFailure('administratively prohibited', config());

        assert.match(message, /AllowTcpForwarding/);
    });

    test('an unreachable destination is named', () => {
        const message = explainForwardFailure('No route to host', config());

        assert.match(message, /db:5432 could not be reached/);
    });

    test('anything else is passed through unchanged', () => {
        assert.strictEqual(explainForwardFailure('something odd', config()), 'something odd');
    });
});

suite('tunnels: destination validation', () => {
    test('rejects a wildcard address as a destination', () => {
        // 0.0.0.0 means "every interface" when binding and nothing at all as
        // a target, but it is easy to pick by analogy with the bind step.
        assert.match(validateHost('0.0.0.0') ?? '', /cannot be a wildcard/);
        assert.match(validateHost('::') ?? '', /cannot be a wildcard/);
        assert.match(validateHost('[::]') ?? '', /cannot be a wildcard/);
    });

    test('still accepts ordinary destinations', () => {
        assert.strictEqual(validateHost('localhost'), undefined);
        assert.strictEqual(validateHost('db.internal'), undefined);
        assert.strictEqual(validateHost('10.0.0.5'), undefined);
        assert.strictEqual(validateHost('[::1]'), undefined);
    });
});
