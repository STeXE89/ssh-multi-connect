import * as assert from 'assert';

/**
 * Guards against a native dependency taking down the extension host.
 *
 * ssh2 lists cpu-features as an optional native dependency. A copy of it built
 * against Node's ABI segfaults when loaded inside Electron, so `require('ssh2')`
 * killed the extension host the moment the extension activated -- exit code 11,
 * before any of our code ran. `.npmrc` now omits optional dependencies; this
 * test fails loudly if they ever come back.
 */
suite('Module loading in the extension host', () => {
    test('loads ssh2 without crashing the host', () => {
        const ssh2 = require('ssh2');

        assert.strictEqual(typeof ssh2.Client, 'function');
        assert.strictEqual(typeof ssh2.utils.parseKey, 'function');
    });

    test('loads every extension module', () => {
        assert.ok(require('../utils/sshConfig').parseSshConfig);
        assert.ok(require('../utils/shell').quote);
        assert.ok(require('../utils/fileUtils').readFile);
        assert.ok(require('../utils/sftpUtils').getSFTPClient);
        assert.ok(require('../remoteFile').RemoteFileProvider);
        assert.ok(require('../sshConnection').SSHViewProvider);
        assert.ok(require('../extension').activate);
    });

    test('reads the real ssh_config without throwing', () => {
        // getAllConnections swallows errors and returns []; this asserts it at
        // least survives whatever is on the developer's machine.
        const { getAllConnections } = require('../utils/sshUtils');

        assert.ok(Array.isArray(getAllConnections()));
    });
});
