import * as assert from 'assert';
import { jumpPlanFor } from '../jumpSession';
import { connectionTooltip, ExtendedSSHConnection } from '../sshConnection';

function connection(overrides: Partial<ExtendedSSHConnection> = {}): ExtendedSSHConnection {
    return { id: 'c1', host: 'web', hostname: '10.0.0.5', ...overrides };
}

suite('jumpPlanFor', () => {
    test('a host with no proxy directives is reached directly', () => {
        assert.deepStrictEqual(jumpPlanFor(connection()), { kind: 'direct' });
    });

    test('reads a ProxyJump chain', () => {
        assert.deepStrictEqual(jumpPlanFor(connection({ proxyJump: 'a,b' })), {
            kind: 'jump',
            hops: [{ host: 'a' }, { host: 'b' }],
        });
    });

    test('"ProxyJump none" cancels an inherited jump', () => {
        assert.deepStrictEqual(jumpPlanFor(connection({ proxyJump: 'none' })), { kind: 'direct' });
    });

    test('ProxyJump wins over ProxyCommand, as it does in ssh', () => {
        assert.deepStrictEqual(jumpPlanFor(connection({ proxyJump: 'a', proxyCommand: 'ssh -W %h:%p b' })), {
            kind: 'jump',
            hops: [{ host: 'a' }],
        });
    });

    test('a ProxyCommand that is only a jump is honoured', () => {
        assert.deepStrictEqual(jumpPlanFor(connection({ proxyCommand: 'ssh -q -W %h:%p bastion' })), {
            kind: 'jump',
            hops: [{ host: 'bastion' }],
        });
    });

    test('any other ProxyCommand is reported, not run', () => {
        assert.deepStrictEqual(jumpPlanFor(connection({ proxyCommand: 'aws ssm start-session --target %h' })), {
            kind: 'unsupported',
            command: 'ProxyCommand aws ssm start-session --target %h',
        });
    });

    test('a malformed ProxyJump is reported rather than ignored', () => {
        assert.deepStrictEqual(jumpPlanFor(connection({ proxyJump: 'bastion:not-a-port' })), {
            kind: 'unsupported',
            command: 'ProxyJump bastion:not-a-port',
        });
    });
});

suite('connectionTooltip: jumps', () => {
    test('names the bastions a host is reached through', () => {
        assert.ok(connectionTooltip(connection({ proxyJump: 'jump@bastion' })).includes('Via: jump@bastion'));
    });

    test('says nothing when there are none', () => {
        assert.ok(!connectionTooltip(connection()).includes('Via:'));
    });
});
