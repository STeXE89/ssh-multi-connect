import * as assert from 'assert';
import { parseProxyJump, proxyJumpFromCommand, hopPort } from '../utils/proxyJump';
import { parseSshConfig, buildConnectionEntry } from '../utils/sshConfig';

suite('parseProxyJump', () => {
    test('reads a bare host', () => {
        assert.deepStrictEqual(parseProxyJump('bastion'), [{ host: 'bastion' }]);
    });

    test('reads user and port', () => {
        assert.deepStrictEqual(parseProxyJump('jump@bastion:2222'), [{ host: 'bastion', user: 'jump', port: 2222 }]);
    });

    test('keeps the order of a multi-hop chain', () => {
        assert.deepStrictEqual(parseProxyJump('a@first, second:2222 ,third'), [
            { host: 'first', user: 'a' },
            { host: 'second', port: 2222 },
            { host: 'third' },
        ]);
    });

    test('reads a bracketed IPv6 literal with a port', () => {
        assert.deepStrictEqual(parseProxyJump('[fe80::1]:2222'), [{ host: 'fe80::1', port: 2222 }]);
    });

    test('leaves a bare IPv6 literal whole', () => {
        assert.deepStrictEqual(parseProxyJump('fe80::1'), [{ host: 'fe80::1' }]);
    });

    test('treats "none" as no jump at all, not as an error', () => {
        assert.deepStrictEqual(parseProxyJump('none'), []);
        assert.deepStrictEqual(parseProxyJump('None'), []);
    });

    test('rejects malformed hops', () => {
        assert.strictEqual(parseProxyJump('@bastion'), undefined);
        assert.strictEqual(parseProxyJump('bastion:'), undefined);
        assert.strictEqual(parseProxyJump('bastion:port'), undefined);
        assert.strictEqual(parseProxyJump('bastion:99999'), undefined);
        assert.strictEqual(parseProxyJump('a,,b'), undefined);
    });
});

suite('proxyJumpFromCommand', () => {
    test('recognises the -W form', () => {
        assert.strictEqual(proxyJumpFromCommand('ssh -W %h:%p bastion'), 'bastion');
    });

    test('ignores flags that carry no host', () => {
        assert.strictEqual(proxyJumpFromCommand('ssh -q -A -W %h:%p jump@bastion'), 'jump@bastion');
    });

    test('folds -l and -p into the jump spec', () => {
        assert.strictEqual(proxyJumpFromCommand('ssh -l jump -p 2222 -W %h:%p bastion'), 'jump@bastion:2222');
    });

    test('recognises the older netcat form', () => {
        assert.strictEqual(proxyJumpFromCommand('ssh bastion nc %h %p'), 'bastion');
    });

    test('skips the value of flags that take one', () => {
        assert.strictEqual(proxyJumpFromCommand('ssh -i /home/me/.ssh/id_ed25519 -W %h:%p bastion'), 'bastion');
    });

    test('accepts an absolute path to ssh', () => {
        assert.strictEqual(proxyJumpFromCommand('/usr/bin/ssh -W %h:%p bastion'), 'bastion');
    });

    test('declines commands that are not a plain jump', () => {
        assert.strictEqual(proxyJumpFromCommand('corkscrew proxy 8080 %h %p'), undefined);
        assert.strictEqual(proxyJumpFromCommand('aws ssm start-session --target %h'), undefined);
        assert.strictEqual(proxyJumpFromCommand('ssh bastion'), undefined);
        assert.strictEqual(proxyJumpFromCommand('ssh -W %h:%p'), undefined);
        assert.strictEqual(proxyJumpFromCommand('ssh --strange-flag -W %h:%p bastion'), undefined);
    });
});

suite('hopPort', () => {
    test('prefers the port written on the hop', () => {
        assert.strictEqual(hopPort({ host: 'b', port: 2222 }, 2022), 2222);
    });

    test('falls back to the host block, then to 22', () => {
        assert.strictEqual(hopPort({ host: 'b' }, 2022), 2022);
        assert.strictEqual(hopPort({ host: 'b' }), 22);
    });
});

suite('ssh_config: ProxyJump', () => {
    test('parses and serialises the directive', () => {
        const [connection] = parseSshConfig(['Host web', '  HostName 10.0.0.5', '  ProxyJump bastion'].join('\n'));

        assert.strictEqual(connection.proxyJump, 'bastion');
        assert.ok(buildConnectionEntry(connection).includes('  ProxyJump bastion'));
    });
});
