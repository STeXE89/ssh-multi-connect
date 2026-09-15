import * as assert from 'assert';
import { parseSshConfig, buildConnectionEntry, SSHConnection } from '../utils/sshConfig';
import {
    parseForwardSpec,
    forwardSpec,
    forwardDirective,
    LOOPBACK,
    ALL_INTERFACES,
    TunnelConfig,
} from '../utils/tunnelModel';

suite('ssh_config: forward directives', () => {
    test('keeps every LocalForward line, not just the last', () => {
        const [connection] = parseSshConfig(
            ['Host web', '  HostName 10.0.0.5', '  LocalForward 8080 localhost:80', '  LocalForward 5432 db:5432'].join(
                '\n'
            )
        );

        assert.deepStrictEqual(connection.localForward, ['8080 localhost:80', '5432 db:5432']);
    });

    test('keeps every RemoteForward line', () => {
        const [connection] = parseSshConfig(
            ['Host web', '  RemoteForward 9090 localhost:3000', '  RemoteForward 9091 localhost:3001'].join('\n')
        );

        assert.deepStrictEqual(connection.remoteForward, ['9090 localhost:3000', '9091 localhost:3001']);
    });

    test('serialises one line per forward', () => {
        const connection: SSHConnection = {
            host: 'web',
            hostname: '10.0.0.5',
            localForward: ['8080 localhost:80', '5432 db:5432'],
            remoteForward: ['9090 localhost:3000'],
        };

        const entry = buildConnectionEntry(connection);

        assert.ok(entry.includes('  LocalForward 8080 localhost:80'));
        assert.ok(entry.includes('  LocalForward 5432 db:5432'));
        assert.ok(entry.includes('  RemoteForward 9090 localhost:3000'));
    });

    test('round-trips through parse and serialise', () => {
        const original: SSHConnection = {
            host: 'web',
            hostname: '10.0.0.5',
            localForward: ['8080 localhost:80', '5432 db:5432'],
        };

        const [reparsed] = parseSshConfig(buildConnectionEntry(original));

        assert.deepStrictEqual(reparsed.localForward, original.localForward);
    });
});

suite('parseForwardSpec', () => {
    test('reads the whitespace form and defaults the bind address to loopback', () => {
        assert.deepStrictEqual(parseForwardSpec('8080 localhost:80', 'local'), {
            kind: 'local',
            bindAddress: LOOPBACK,
            listenPort: 8080,
            destinationHost: 'localhost',
            destinationPort: 80,
        });
    });

    test('reads an explicit bind address', () => {
        assert.deepStrictEqual(parseForwardSpec('0.0.0.0:8080 db:5432', 'local'), {
            kind: 'local',
            bindAddress: '0.0.0.0',
            listenPort: 8080,
            destinationHost: 'db',
            destinationPort: 5432,
        });
    });

    test('reads the colon-joined -L form', () => {
        assert.deepStrictEqual(parseForwardSpec('127.0.0.1:8080:db:5432', 'remote'), {
            kind: 'remote',
            bindAddress: '127.0.0.1',
            listenPort: 8080,
            destinationHost: 'db',
            destinationPort: 5432,
        });
    });

    test('strips brackets from IPv6 literals', () => {
        assert.deepStrictEqual(parseForwardSpec('[::1]:8080 [fe80::1]:80', 'local'), {
            kind: 'local',
            bindAddress: '::1',
            listenPort: 8080,
            destinationHost: 'fe80::1',
            destinationPort: 80,
        });
    });

    test('accepts listen port 0, which asks for any free port', () => {
        assert.strictEqual(parseForwardSpec('0 localhost:80', 'local')?.listenPort, 0);
    });

    test('rejects a dynamic RemoteForward, which has no destination', () => {
        assert.strictEqual(parseForwardSpec('1080', 'remote'), undefined);
    });

    test('rejects specs that are not port numbers', () => {
        assert.strictEqual(parseForwardSpec('http localhost:80', 'local'), undefined);
        assert.strictEqual(parseForwardSpec('8080 localhost:http', 'local'), undefined);
        assert.strictEqual(parseForwardSpec('8080 localhost:99999', 'local'), undefined);
    });

    test('rejects a wildcard destination', () => {
        assert.strictEqual(parseForwardSpec('8080 0.0.0.0:80', 'local'), undefined);
    });

    test('rejects specs with too many or too few fields', () => {
        assert.strictEqual(parseForwardSpec('8080 localhost', 'local'), undefined);
        assert.strictEqual(parseForwardSpec('1.2.3.4:8080 db:5432 extra', 'local'), undefined);
        assert.strictEqual(parseForwardSpec('a:b:1.2.3.4:8080:db:5432', 'local'), undefined);
    });
});

suite('forwardSpec: writing a tunnel back to ssh_config', () => {
    const config = (overrides: Partial<TunnelConfig> = {}): TunnelConfig => ({
        id: 't1',
        kind: 'local',
        bindAddress: LOOPBACK,
        listenPort: 8080,
        destinationHost: 'localhost',
        destinationPort: 80,
        ...overrides,
    });

    test('names the directive by direction', () => {
        assert.strictEqual(forwardDirective(config()), 'LocalForward');
        assert.strictEqual(forwardDirective(config({ kind: 'remote' })), 'RemoteForward');
    });

    test('writes the whitespace form ssh_config documents', () => {
        assert.strictEqual(forwardSpec(config()), '127.0.0.1:8080 localhost:80');
    });

    test('brackets an IPv6 literal so it does not run into its port', () => {
        const spec = forwardSpec(config({ bindAddress: '::1', destinationHost: 'fe80::1' }));

        assert.strictEqual(spec, '[::1]:8080 [fe80::1]:80');
    });

    test('round-trips through the parser, which is what reads it back', () => {
        for (const tunnel of [
            config(),
            config({ kind: 'remote', bindAddress: ALL_INTERFACES, listenPort: 9090 }),
            config({ bindAddress: '::1', destinationHost: 'fe80::1' }),
        ]) {
            const parsed = parseForwardSpec(forwardSpec(tunnel), tunnel.kind);

            assert.deepStrictEqual(parsed, {
                kind: tunnel.kind,
                bindAddress: tunnel.bindAddress,
                listenPort: tunnel.listenPort,
                destinationHost: tunnel.destinationHost,
                destinationPort: tunnel.destinationPort,
            });
        }
    });
});
