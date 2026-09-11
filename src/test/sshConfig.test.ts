import * as assert from 'assert';
import {
    parseSshConfig,
    buildConnectionEntry,
    upsertConnection,
    removeHost,
    hasHost,
    SSHConnection,
} from '../utils/sshConfig';

suite('sshConfig: parsing', () => {
    test('parses a full host block', () => {
        const content = [
            'Host web',
            '  HostName 10.0.0.5',
            '  User deploy',
            '  Port 2222',
            '  IdentityFile /home/me/.ssh/web_key',
            '',
        ].join('\n');

        const [connection] = parseSshConfig(content);

        assert.strictEqual(connection.host, 'web');
        assert.strictEqual(connection.hostname, '10.0.0.5');
        assert.strictEqual(connection.user, 'deploy');
        assert.strictEqual(connection.port, 2222);
        assert.strictEqual(connection.identityFile, '/home/me/.ssh/web_key');
    });

    test('parses several blocks in file order', () => {
        const content = 'Host a\n  HostName 1.1.1.1\n\nHost b\n  HostName 2.2.2.2\n';

        assert.deepStrictEqual(
            parseSshConfig(content).map(c => c.host),
            ['a', 'b']
        );
    });

    test('treats keywords as case-insensitive', () => {
        // ssh_config keywords are case-insensitive; a lowercase `hostname` must
        // not be silently dropped.
        const content = 'Host web\n  hostname 10.0.0.5\n  USER deploy\n  port 2222\n';

        const [connection] = parseSshConfig(content);

        assert.strictEqual(connection.hostname, '10.0.0.5');
        assert.strictEqual(connection.user, 'deploy');
        assert.strictEqual(connection.port, 2222);
    });

    test('accepts the Key=Value form', () => {
        const content = 'Host web\n  HostName=10.0.0.5\n  User=deploy\n';

        const [connection] = parseSshConfig(content);

        assert.strictEqual(connection.hostname, '10.0.0.5');
        assert.strictEqual(connection.user, 'deploy');
    });

    test('accepts tabs and extra spacing', () => {
        const content = 'Host\tweb\n\t\tHostName\t10.0.0.5\n';

        const [connection] = parseSshConfig(content);

        assert.strictEqual(connection.host, 'web');
        assert.strictEqual(connection.hostname, '10.0.0.5');
    });

    test('falls back to the alias when HostName is absent', () => {
        // Real ssh connects to the alias itself when no HostName is given.
        const [connection] = parseSshConfig('Host example.com\n  User me\n');

        assert.strictEqual(connection.hostname, 'example.com');
    });

    test('skips wildcard template blocks', () => {
        const content = 'Host *\n  ForwardAgent yes\n\nHost web\n  HostName 10.0.0.5\n';

        assert.deepStrictEqual(
            parseSshConfig(content).map(c => c.host),
            ['web']
        );
    });

    test('reads the vFolderTag comment', () => {
        const content = 'Host web\n  # vFolderTag: Prod/EU\n  HostName 10.0.0.5\n';

        assert.strictEqual(parseSshConfig(content)[0].vFolderTag, 'Prod/EU');
    });

    test('ignores unrelated comments', () => {
        const content = 'Host web\n  # a note about this host\n  HostName 10.0.0.5\n';

        const [connection] = parseSshConfig(content);

        assert.strictEqual(connection.vFolderTag, undefined);
        assert.strictEqual(connection.hostname, '10.0.0.5');
    });

    test('ignores a non-numeric or out-of-range port', () => {
        assert.strictEqual(parseSshConfig('Host a\n  Port abc\n')[0].port, undefined);
        assert.strictEqual(parseSshConfig('Host a\n  Port 99999\n')[0].port, undefined);
    });

    test('reads boolean directives', () => {
        const content = 'Host a\n  ForwardAgent yes\n  Compression no\n';

        const [connection] = parseSshConfig(content);

        assert.strictEqual(connection.forwardAgent, true);
        assert.strictEqual(connection.compression, false);
    });

    test('returns nothing for empty content', () => {
        assert.deepStrictEqual(parseSshConfig(''), []);
    });
});

suite('sshConfig: serialization', () => {
    test('emits only the fields that are set', () => {
        const entry = buildConnectionEntry({ host: 'web', hostname: '10.0.0.5' });

        assert.strictEqual(entry, 'Host web\n  HostName 10.0.0.5');
    });

    test('puts the vFolderTag comment inside the block', () => {
        const entry = buildConnectionEntry({
            host: 'web',
            hostname: '10.0.0.5',
            vFolderTag: 'Prod',
        });

        assert.strictEqual(entry, 'Host web\n  # vFolderTag: Prod\n  HostName 10.0.0.5');
    });

    test('round-trips a connection through parse and build', () => {
        const original: SSHConnection = {
            host: 'web',
            hostname: '10.0.0.5',
            user: 'deploy',
            port: 2222,
            identityFile: '/home/me/.ssh/web_key',
            forwardAgent: true,
            compression: false,
            vFolderTag: 'Prod/EU',
        };

        const [reparsed] = parseSshConfig(buildConnectionEntry(original));

        assert.deepStrictEqual(reparsed, original);
    });
});

suite('sshConfig: upsert', () => {
    test('appends a host to an empty config', () => {
        const result = upsertConnection('', { host: 'web', hostname: '10.0.0.5' });

        assert.strictEqual(result, 'Host web\n  HostName 10.0.0.5\n');
    });

    test('replaces an existing block in place', () => {
        const content = 'Host web\n  HostName old.example\n  User old\n\nHost db\n  HostName 2.2.2.2\n';

        const result = upsertConnection(content, { host: 'web', hostname: 'new.example', user: 'new' });

        assert.ok(result.includes('HostName new.example'));
        assert.ok(!result.includes('old.example'));
        assert.ok(!result.includes('User old'));
        // The untouched block keeps its position and content.
        assert.deepStrictEqual(
            parseSshConfig(result).map(c => c.host),
            ['web', 'db']
        );
    });

    test('preserves directives it does not model', () => {
        // A config shared with the real ssh client must not lose settings the
        // extension has no field for.
        const content = 'Host db\n  HostName 2.2.2.2\n  Ciphers aes256-gcm@openssh.com\n  # keep me\n';

        const result = upsertConnection(content, { host: 'web', hostname: '10.0.0.5' });

        assert.ok(result.includes('Ciphers aes256-gcm@openssh.com'));
        assert.ok(result.includes('# keep me'));
    });

    test('preserves the preamble above the first host', () => {
        const content = '# my ssh config\n\nHost db\n  HostName 2.2.2.2\n';

        const result = upsertConnection(content, { host: 'web', hostname: '10.0.0.5' });

        assert.ok(result.startsWith('# my ssh config\n'));
    });

    test('keeps a wildcard block untouched', () => {
        const content = 'Host *\n  ServerAliveInterval 60\n';

        const result = upsertConnection(content, { host: 'web', hostname: '10.0.0.5' });

        assert.ok(result.includes('Host *'));
        assert.ok(result.includes('ServerAliveInterval 60'));
    });

    test('separates blocks with exactly one blank line', () => {
        let content = upsertConnection('', { host: 'a', hostname: '1.1.1.1' });
        content = upsertConnection(content, { host: 'b', hostname: '2.2.2.2' });

        assert.strictEqual(content, 'Host a\n  HostName 1.1.1.1\n\nHost b\n  HostName 2.2.2.2\n');
    });

    test('does not duplicate a host when updated repeatedly', () => {
        let content = upsertConnection('', { host: 'web', hostname: '1.1.1.1' });
        content = upsertConnection(content, { host: 'web', hostname: '2.2.2.2' });
        content = upsertConnection(content, { host: 'web', hostname: '3.3.3.3' });

        const parsed = parseSshConfig(content);
        assert.strictEqual(parsed.length, 1);
        assert.strictEqual(parsed[0].hostname, '3.3.3.3');
    });

    test('updates the last block in the file', () => {
        // The previous writer only flushed a replacement when it met the *next*
        // Host line, so the final block was a special case.
        const content = 'Host a\n  HostName 1.1.1.1\n\nHost b\n  HostName 2.2.2.2\n';

        const result = upsertConnection(content, { host: 'b', hostname: 'changed' });

        const parsed = parseSshConfig(result);
        assert.strictEqual(parsed.length, 2);
        assert.strictEqual(parsed[1].hostname, 'changed');
    });
});

suite('sshConfig: remove', () => {
    test('removes only the named host', () => {
        const content = 'Host a\n  HostName 1.1.1.1\n\nHost b\n  HostName 2.2.2.2\n';

        const result = removeHost(content, 'a');

        assert.deepStrictEqual(
            parseSshConfig(result).map(c => c.host),
            ['b']
        );
    });

    test('removes the whole block including its directives', () => {
        const content = 'Host a\n  HostName 1.1.1.1\n  User me\n  # vFolderTag: X\n\nHost b\n  HostName 2.2.2.2\n';

        const result = removeHost(content, 'a');

        assert.ok(!result.includes('1.1.1.1'));
        assert.ok(!result.includes('User me'));
        assert.ok(!result.includes('vFolderTag'));
    });

    test('is a no-op for an unknown host', () => {
        const content = 'Host a\n  HostName 1.1.1.1\n';

        assert.strictEqual(removeHost(content, 'nope'), content);
    });

    test('leaves an empty string when the last host goes', () => {
        assert.strictEqual(removeHost('Host a\n  HostName 1.1.1.1\n', 'a'), '');
    });

    test('keeps the preamble', () => {
        const content = '# header\n\nHost a\n  HostName 1.1.1.1\n';

        assert.strictEqual(removeHost(content, 'a'), '# header\n');
    });
});

suite('sshConfig: hasHost', () => {
    test('detects present and absent hosts', () => {
        const content = 'Host web\n  HostName 10.0.0.5\n';

        assert.strictEqual(hasHost(content, 'web'), true);
        assert.strictEqual(hasHost(content, 'db'), false);
    });

    test('does not count a wildcard block as a host', () => {
        assert.strictEqual(hasHost('Host *\n  ForwardAgent yes\n', '*'), true);
    });
});
