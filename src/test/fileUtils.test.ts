import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const POSIX_MODES = process.platform !== 'win32';

import {
    ensureDirectoryExists,
    ensureFileExists,
    fileExists,
    readFile,
    writeFile,
    appendToFile,
    readFileAsync,
    writeFileAsync,
    deleteFile,
    createTempFile,
    watchFile,
    getPrivateTempDir,
    removePrivateTempDir,
    restrictToOwner,
} from '../utils/fileUtils';

let workDir: string;

setup(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-multi-connect-test-'));
});

teardown(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
});

suite('fileUtils: directories and existence', () => {
    test('creates a directory with the requested mode', () => {
        const target = path.join(workDir, 'nested');

        ensureDirectoryExists(target, 0o700);

        assert.ok(fs.existsSync(target));
        if (POSIX_MODES) {
            assert.strictEqual(fs.statSync(target).mode & 0o777, 0o700);
        }
    });

    test('is a no-op when the directory already exists', () => {
        const target = path.join(workDir, 'nested');
        ensureDirectoryExists(target, 0o700);

        assert.doesNotThrow(() => ensureDirectoryExists(target, 0o700));
    });

    test('creates a missing file with the requested mode', () => {
        const target = path.join(workDir, 'config');

        ensureFileExists(target, 0o600);

        assert.ok(fileExists(target));
        assert.strictEqual(readFile(target), '');
        if (POSIX_MODES) {
            assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
        }
    });

    test('does not truncate a file that already exists', () => {
        // ensureFileExists used to return a Promise no caller awaited; the
        // behaviour it guarantees is "create only when absent".
        const target = path.join(workDir, 'config');
        writeFile(target, 'Host keep-me\n', 0o600);

        ensureFileExists(target, 0o600);

        assert.strictEqual(readFile(target), 'Host keep-me\n');
    });

    test('reports a missing file as absent', () => {
        assert.strictEqual(fileExists(path.join(workDir, 'nope')), false);
    });
});

suite('fileUtils: read and write', () => {
    test('writes then reads content back', () => {
        const target = path.join(workDir, 'file.txt');

        writeFile(target, 'hello', 0o600);

        assert.strictEqual(readFile(target), 'hello');
    });

    test('write applies the requested mode', () => {
        const target = path.join(workDir, 'secret');

        writeFile(target, 'x', 0o600);

        if (POSIX_MODES) {
            assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
        }
    });

    test('append adds to the end without truncating', () => {
        const target = path.join(workDir, 'known_hosts');
        writeFile(target, 'first\n', 0o600);

        appendToFile(target, 'second\n');

        assert.strictEqual(readFile(target), 'first\nsecond\n');
    });

    test('readFile throws a message naming the file', () => {
        assert.throws(() => readFile(path.join(workDir, 'missing.txt')), /missing\.txt/);
    });

    test('async read and write round-trip', async () => {
        const target = path.join(workDir, 'async.txt');

        await writeFileAsync(target, 'async content', 0o600);

        assert.strictEqual(await readFileAsync(target), 'async content');
    });

    test('async read rejects for a missing file', async () => {
        await assert.rejects(readFileAsync(path.join(workDir, 'nope')));
    });
});

suite('fileUtils: deletion', () => {
    test('removes an existing file', async () => {
        const target = path.join(workDir, 'gone.txt');
        writeFile(target, 'x', 0o600);

        await deleteFile(target);

        assert.strictEqual(fileExists(target), false);
    });

    test('rejects for a missing file', async () => {
        await assert.rejects(deleteFile(path.join(workDir, 'never-existed')));
    });
});

suite('fileUtils: temp files', () => {
    test('returns a path inside a per-prefix temp directory', () => {
        const created = createTempFile('ssh-multi-connect-unit', '.txt');

        assert.ok(created.startsWith(path.join(os.tmpdir(), 'ssh-multi-connect-unit')));
        assert.ok(created.endsWith('.txt'));
        fs.rmSync(path.dirname(created), { recursive: true, force: true });
    });

    test('never returns the same name twice', () => {
        // Two calls in the same millisecond used to collide on Date.now().
        const names = new Set(Array.from({ length: 50 }, () => createTempFile('ssh-multi-connect-unit', '.txt')));

        assert.strictEqual(names.size, 50);
        fs.rmSync(path.join(os.tmpdir(), 'ssh-multi-connect-unit'), { recursive: true, force: true });
    });
});

suite('fileUtils: watching', () => {
    test('reports a change even when the platform gives no filename', async () => {
        const target = path.join(workDir, 'watched.txt');
        writeFile(target, 'before', 0o600);

        const seen = await new Promise<string>(resolve => {
            const watcher = watchFile(target, (eventType, filename) => {
                watcher.close();
                resolve(`${eventType}:${filename}`);
            });
            setTimeout(() => writeFile(target, 'after', 0o600), 50);
        });

        // The filename must be filled in rather than dropped, which is what
        // silently disabled the ssh_config watcher on some platforms.
        assert.ok(seen.includes('watched.txt'), `unexpected event: ${seen}`);
    });
});

suite('fileUtils: private temp directory', () => {
    teardown(() => {
        removePrivateTempDir();
    });

    test('creates a directory readable only by its owner', () => {
        // Downloads used to land in the shared system temp directory, where
        // every other local account could read them.
        const dir = getPrivateTempDir();

        assert.ok(fs.existsSync(dir));
        if (POSIX_MODES) {
            assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
        }
    });

    test('reuses the same directory across calls', () => {
        assert.strictEqual(getPrivateTempDir(), getPrivateTempDir());
    });

    test('recreates the directory if it was removed underneath us', () => {
        const first = getPrivateTempDir();
        fs.rmSync(first, { recursive: true, force: true });

        const second = getPrivateTempDir();

        assert.ok(fs.existsSync(second));
    });

    test('removal deletes the directory and its contents', () => {
        const dir = getPrivateTempDir();
        writeFile(path.join(dir, 'downloaded.txt'), 'x', 0o600);

        removePrivateTempDir();

        assert.strictEqual(fs.existsSync(dir), false);
    });

    test('removal is safe when nothing was created', () => {
        assert.doesNotThrow(() => removePrivateTempDir());
    });
});

suite('fileUtils: restrictToOwner', () => {
    test('narrows a permissive file to 0600', () => {
        const target = path.join(workDir, 'downloaded.txt');
        writeFile(target, 'secret', 0o644);

        restrictToOwner(target);

        if (POSIX_MODES) {
            assert.strictEqual(fs.statSync(target).mode & 0o777, 0o600);
        }
        assert.ok(fs.existsSync(target));
    });

    test('is a no-op for a missing file', () => {
        assert.doesNotThrow(() => restrictToOwner(path.join(workDir, 'nope')));
    });
});
