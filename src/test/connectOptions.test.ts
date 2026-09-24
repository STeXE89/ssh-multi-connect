import * as assert from 'assert';
import { connectionTuning, agentAddress, chooseIdentityFile } from '../utils/connectOptions';
import { SSHConnection } from '../utils/sshConfig';

function connection(overrides: Partial<SSHConnection> = {}): SSHConnection {
    return { host: 'web', hostname: '10.0.0.5', ...overrides };
}

suite('connectOptions: keepalive', () => {
    test('converts ServerAliveInterval from seconds to milliseconds', () => {
        // ssh_config counts seconds; ssh2 wants milliseconds.
        assert.strictEqual(
            connectionTuning(connection({ serverAliveInterval: 60 }), undefined).keepaliveInterval,
            60000
        );
    });

    test('passes ServerAliveCountMax through unchanged', () => {
        assert.strictEqual(connectionTuning(connection({ serverAliveCountMax: 3 }), undefined).keepaliveCountMax, 3);
    });

    test('zero disables keepalive rather than being ignored', () => {
        assert.strictEqual(connectionTuning(connection({ serverAliveInterval: 0 }), undefined).keepaliveInterval, 0);
    });

    test('says nothing when the directives are absent', () => {
        const tuning = connectionTuning(connection(), undefined);

        assert.strictEqual(tuning.keepaliveInterval, undefined);
        assert.strictEqual(tuning.keepaliveCountMax, undefined);
    });
});

suite('connectOptions: compression', () => {
    test('prefers zlib when Compression is yes', () => {
        const compress = connectionTuning(connection({ compression: true }), undefined).algorithms?.compress;

        assert.deepStrictEqual(compress, ['zlib@openssh.com', 'zlib', 'none']);
    });

    test('disables it when Compression is no', () => {
        assert.deepStrictEqual(connectionTuning(connection({ compression: false }), undefined).algorithms?.compress, [
            'none',
        ]);
    });

    test('leaves the negotiation alone when unset', () => {
        assert.strictEqual(connectionTuning(connection(), undefined).algorithms, undefined);
    });
});

suite('connectOptions: agent forwarding', () => {
    test('offers the agent when ForwardAgent is yes', () => {
        const tuning = connectionTuning(connection({ forwardAgent: true }), '/tmp/agent.sock');

        assert.strictEqual(tuning.agent, '/tmp/agent.sock');
        assert.strictEqual(tuning.agentForward, true);
    });

    test('stays silent when ForwardAgent is no', () => {
        const tuning = connectionTuning(connection({ forwardAgent: false }), '/tmp/agent.sock');

        assert.strictEqual(tuning.agent, undefined);
        assert.strictEqual(tuning.agentForward, undefined);
    });

    test('does not claim an agent that is not running', () => {
        // Asking for forwarding with no reachable agent only fails at connect.
        const tuning = connectionTuning(connection({ forwardAgent: true }), undefined);

        assert.strictEqual(tuning.agent, undefined);
        assert.strictEqual(tuning.agentForward, undefined);
    });
});

suite('connectOptions: locating the agent', () => {
    test('uses SSH_AUTH_SOCK when set', () => {
        assert.strictEqual(agentAddress({ SSH_AUTH_SOCK: '/run/agent' }, 'linux'), '/run/agent');
    });

    test('falls back to pageant on Windows, which has no SSH_AUTH_SOCK', () => {
        assert.strictEqual(agentAddress({}, 'win32'), 'pageant');
    });

    test('reports none elsewhere', () => {
        assert.strictEqual(agentAddress({}, 'linux'), undefined);
    });
});

suite('connectOptions: choosing the key', () => {
    const convention = () => '/home/me/.ssh/host_key';

    test('uses the key ssh_config names', () => {
        assert.strictEqual(
            chooseIdentityFile('/home/me/.ssh/project_ed25519', convention),
            '/home/me/.ssh/project_ed25519'
        );
    });

    test("falls back to this extension's own convention when the config names none", () => {
        assert.strictEqual(chooseIdentityFile(undefined, convention), '/home/me/.ssh/host_key');
        assert.strictEqual(chooseIdentityFile('   ', convention), '/home/me/.ssh/host_key');
    });

    test('does not go looking for the fallback when it is not needed', () => {
        // The fallback throws when the conventional file is absent, so reaching
        // for it unnecessarily turns a working connection into an error.
        const explode = () => {
            throw new Error('should not have been called');
        };

        assert.strictEqual(chooseIdentityFile('/home/me/.ssh/named', explode), '/home/me/.ssh/named');
    });

    test('trims the path, since ssh_config values keep their spacing', () => {
        assert.strictEqual(chooseIdentityFile('  /home/me/.ssh/named  ', convention), '/home/me/.ssh/named');
    });
});
