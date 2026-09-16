import * as assert from 'assert';
import { backoffDelays, canReconnectSilently, describeAttempt, defaultKeepalive } from '../utils/reconnect';
import { connectionTuning } from '../utils/connectOptions';
import { SSHConnection } from '../utils/sshConfig';

const connection = (overrides: Partial<SSHConnection> & Record<string, unknown> = {}) =>
    ({ host: 'web', hostname: '10.0.0.5', ...overrides }) as SSHConnection & Record<string, unknown>;

suite('reconnect: timing', () => {
    test('waits longer after each failure', () => {
        assert.deepStrictEqual(backoffDelays(4, 1000, 30000), [1000, 2000, 4000, 8000]);
    });

    test('stops growing at the ceiling, so a dead host is not hammered', () => {
        const delays = backoffDelays(8, 1000, 4000);

        assert.deepStrictEqual(delays.slice(-3), [4000, 4000, 4000]);
    });

    test('starts soon, since a link that came back with the machine is ready at once', () => {
        assert.ok(backoffDelays(5)[0] <= 2000);
    });

    test('asks for no attempts when told none', () => {
        assert.deepStrictEqual(backoffDelays(0), []);
        assert.deepStrictEqual(backoffDelays(-1), []);
    });
});

suite('reconnect: whether it can be done silently', () => {
    test('a password typed this session is enough', () => {
        assert.ok(canReconnectSilently(connection({ password: 'typed' })));
    });

    test('a key already read is enough', () => {
        assert.ok(canReconnectSilently(connection({ identityFile: '/k', privateKey: Buffer.from('x') })));
    });

    test('a key with its passphrase remembered is enough', () => {
        assert.ok(canReconnectSilently(connection({ identityFile: '/k', passphrase: 'secret' })));
    });

    test('a host with nothing held is left alone rather than prompting an empty room', () => {
        assert.ok(!canReconnectSilently(connection()));
        assert.ok(!canReconnectSilently(connection({ identityFile: '/k' })));
    });
});

suite('reconnect: keepalive', () => {
    test('probes by default, which is what notices a suspended machine', () => {
        assert.deepStrictEqual(defaultKeepalive(30), { keepaliveInterval: 30000, keepaliveCountMax: 3 });
    });

    test('zero turns probing off', () => {
        assert.strictEqual(defaultKeepalive(0), undefined);
        assert.strictEqual(defaultKeepalive(-5), undefined);
    });

    test('applies the fallback to a host whose config says nothing', () => {
        const tuning = connectionTuning(connection(), undefined, 30);

        assert.strictEqual(tuning.keepaliveInterval, 30000);
        assert.strictEqual(tuning.keepaliveCountMax, 3);
    });

    test('ServerAliveInterval wins over the fallback', () => {
        const tuning = connectionTuning(connection({ serverAliveInterval: 5 }), undefined, 30);

        assert.strictEqual(tuning.keepaliveInterval, 5000);
    });

    test('ServerAliveInterval 0 disables probing even with a fallback set', () => {
        const tuning = connectionTuning(connection({ serverAliveInterval: 0 }), undefined, 30);

        assert.strictEqual(tuning.keepaliveInterval, 0);
    });

    test('stays silent when the fallback is off and the config says nothing', () => {
        assert.deepStrictEqual(connectionTuning(connection(), undefined, 0), {});
    });
});

suite('reconnect: what the user is told', () => {
    test('counts the attempt', () => {
        assert.strictEqual(describeAttempt('web', 0, 5), 'Reconnecting to web (1 of 5)');
        assert.strictEqual(describeAttempt('web', 4, 5), 'Reconnecting to web (5 of 5)');
    });
});
