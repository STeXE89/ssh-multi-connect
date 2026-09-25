import * as assert from 'assert';
import { createHash } from 'crypto';
import { fingerprintOfKey, keyAlgorithm, knownHostsLine, hostKeyStatus } from '../utils/hostKeys';

/** Builds a key blob the way the SSH wire format does. */
function blob(algorithm: string, body = 'body'): Buffer {
    const name = Buffer.from(algorithm, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(name.length, 0);
    return Buffer.concat([length, name, Buffer.from(body)]);
}

suite('hostKeys: fingerprints', () => {
    test('matches the format ssh-keygen -l prints', () => {
        const key = blob('ssh-ed25519');
        const expected = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');

        assert.strictEqual(fingerprintOfKey(key), `SHA256:${expected}`);
    });

    test('carries no base64 padding, which OpenSSH omits', () => {
        assert.ok(!fingerprintOfKey(blob('ssh-rsa')).includes('='));
    });
});

suite('hostKeys: algorithm', () => {
    test('reads the algorithm name out of the blob', () => {
        assert.strictEqual(keyAlgorithm(blob('ssh-ed25519')), 'ssh-ed25519');
        assert.strictEqual(keyAlgorithm(blob('ecdsa-sha2-nistp256')), 'ecdsa-sha2-nistp256');
    });

    test('refuses a blob that is not a key', () => {
        assert.strictEqual(keyAlgorithm(Buffer.alloc(0)), undefined);
        assert.strictEqual(keyAlgorithm(Buffer.from([0, 0, 0, 9, 1])), undefined);
        assert.strictEqual(keyAlgorithm(blob('has space')), undefined);
    });
});

suite('hostKeys: known_hosts lines', () => {
    test('writes host, algorithm and key', () => {
        const key = blob('ssh-ed25519');

        assert.strictEqual(knownHostsLine('10.0.0.5', 22, key), `10.0.0.5 ssh-ed25519 ${key.toString('base64')}`);
    });

    test('brackets the host when the port is not the default', () => {
        assert.ok(knownHostsLine('10.0.0.5', 2222, blob('ssh-rsa'))?.startsWith('[10.0.0.5]:2222 ssh-rsa '));
    });

    test('returns nothing for a blob that is not a key', () => {
        assert.strictEqual(knownHostsLine('h', 22, Buffer.from('nonsense')), undefined);
    });
});

suite('hostKeys: deciding whether a host changed', () => {
    const rsa = 'SHA256:9tmvOHjMaX5WVBbkpwreoT';
    const ecdsa = 'SHA256:byyDSH6leplhrteNgk46iK';
    const ed25519 = 'SHA256:K7nUe7/9evlnDVBovS+VCH';

    test('a host with nothing recorded is unknown', () => {
        assert.strictEqual(hostKeyStatus([], [rsa]), 'unknown');
    });

    test('the same keys match', () => {
        assert.strictEqual(hostKeyStatus([rsa, ecdsa, ed25519], [rsa, ecdsa, ed25519]), 'matches');
    });

    test('order does not matter, which is the whole point', () => {
        // ssh-keyscan opens a connection per key type, so the order it returns
        // them in follows the network. Comparing the first of each reported a
        // changed key every time the orders happened to differ.
        assert.strictEqual(hostKeyStatus([rsa, ecdsa, ed25519], [ed25519, rsa, ecdsa]), 'matches');
    });

    test('one key in common is enough, as when a host adds a type', () => {
        assert.strictEqual(hostKeyStatus([rsa], [rsa, ed25519]), 'matches');
    });

    test('a host that shares none of them has changed', () => {
        assert.strictEqual(hostKeyStatus([rsa, ecdsa], ['SHA256:completely-different']), 'changed');
    });

    test('a host offering nothing at all counts as changed, not as matching', () => {
        assert.strictEqual(hostKeyStatus([rsa], []), 'changed');
    });
});
