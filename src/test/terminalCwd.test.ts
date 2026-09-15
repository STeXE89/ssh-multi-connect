import * as assert from 'assert';
import { spawnSync } from 'child_process';
import { CwdScanner, directoryFromOsc7, CWD_REPORT_SETUP } from '../utils/terminalCwd';

const osc7 = (path: string) => `\x1b]7;file://host${path}\x07`;

suite('terminalCwd: reading an OSC 7 payload', () => {
    test('takes the path and discards the host', () => {
        assert.strictEqual(directoryFromOsc7('file://donatello/var/log'), '/var/log');
    });

    test('copes with no host at all, which is legal', () => {
        assert.strictEqual(directoryFromOsc7('file:///etc'), '/etc');
    });

    test('decodes escapes, so a space survives', () => {
        assert.strictEqual(directoryFromOsc7('file://host/home/me/my%20files'), '/home/me/my files');
    });

    test('keeps the root as the root', () => {
        assert.strictEqual(directoryFromOsc7('file://host/'), '/');
    });

    test('drops a trailing slash elsewhere, so it compares equal to the tree', () => {
        assert.strictEqual(directoryFromOsc7('file://host/var/log/'), '/var/log');
    });

    test('ignores anything that is not a file URI', () => {
        assert.strictEqual(directoryFromOsc7('https://example.com/x'), undefined);
        assert.strictEqual(directoryFromOsc7('nonsense'), undefined);
    });

    test('survives a malformed escape rather than throwing', () => {
        assert.strictEqual(directoryFromOsc7('file://host/bad%ZZ'), undefined);
    });
});

suite('terminalCwd: scanning a stream', () => {
    test('finds a report among ordinary output', () => {
        const scanner = new CwdScanner();

        assert.deepStrictEqual(scanner.push(`total 8\r\n${osc7('/var/log')}user@host:~$ `), ['/var/log']);
    });

    test('finds several in one chunk, in order', () => {
        const scanner = new CwdScanner();

        assert.deepStrictEqual(scanner.push(`${osc7('/a')}x${osc7('/b')}`), ['/a', '/b']);
    });

    test('carries a sequence split across two reads', () => {
        const scanner = new CwdScanner();
        const full = osc7('/home/me');
        const cut = Math.floor(full.length / 2);

        assert.deepStrictEqual(scanner.push(full.slice(0, cut)), []);
        assert.deepStrictEqual(scanner.push(full.slice(cut)), ['/home/me']);
    });

    test('accepts the ST terminator as well as BEL', () => {
        const scanner = new CwdScanner();

        assert.deepStrictEqual(scanner.push('\x1b]7;file://host/srv\x1b\\'), ['/srv']);
    });

    test("understands iTerm's CurrentDir form", () => {
        const scanner = new CwdScanner();

        assert.deepStrictEqual(scanner.push('\x1b]1337;CurrentDir=/opt\x07'), ['/opt']);
    });

    test('reports nothing for output that carries no sequence', () => {
        const scanner = new CwdScanner();

        assert.deepStrictEqual(scanner.push('just some text\r\n'), []);
    });

    test('is not confused by other escape sequences', () => {
        const scanner = new CwdScanner();
        const coloured = '\x1b[32mgreen\x1b[0m';

        assert.deepStrictEqual(scanner.push(`${coloured}${osc7('/tmp')}`), ['/tmp']);
    });

    test('does not grow without bound on output that never terminates a sequence', () => {
        const scanner = new CwdScanner();

        scanner.push(`\x1b]${'x'.repeat(8000)}`);

        // The next real report still arrives, so nothing is stuck.
        assert.deepStrictEqual(scanner.push(osc7('/after')), ['/after']);
    });
});

suite('terminalCwd: asking the shell to report', () => {
    test('covers both shells the setup line claims to', () => {
        assert.ok(CWD_REPORT_SETUP.includes('PROMPT_COMMAND'));
        assert.ok(CWD_REPORT_SETUP.includes('precmd_functions'));
    });

    test('emits the sequence the scanner reads', () => {
        assert.ok(CWD_REPORT_SETUP.includes(']7;file://'));
    });

    test('keeps whatever PROMPT_COMMAND was already there', () => {
        assert.ok(CWD_REPORT_SETUP.includes('${PROMPT_COMMAND:+'));
    });

    test('is a single line, since it is typed into a shell', () => {
        assert.ok(!CWD_REPORT_SETUP.includes('\n'));
    });

    test('runs silently on a POSIX shell that cannot use it', () => {
        // dash and ash are the shells on minimal and embedded hosts, and they
        // cannot parse bash array syntax at all -- not even inside an if that
        // would never run, since parsing happens first.
        const result = spawnSync('sh', ['-c', CWD_REPORT_SETUP], { encoding: 'utf-8' });

        assert.strictEqual(result.status, 0, result.stderr);
        assert.strictEqual(result.stderr.trim(), '');
        assert.strictEqual(result.stdout.trim(), '');
    });

    test('actually reports a directory when the shell is bash', () => {
        const result = spawnSync('bash', ['-c', `${CWD_REPORT_SETUP}; eval "$PROMPT_COMMAND"`], {
            encoding: 'utf-8',
            cwd: '/tmp',
        });

        assert.strictEqual(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes(']7;file://'), result.stdout);
        assert.ok(result.stdout.includes('/tmp'), result.stdout);
    });

    test('what bash emits is what the scanner reads', () => {
        const result = spawnSync('bash', ['-c', `${CWD_REPORT_SETUP}; eval "$PROMPT_COMMAND"`], {
            encoding: 'utf-8',
            cwd: '/tmp',
        });

        assert.deepStrictEqual(new CwdScanner().push(result.stdout), ['/tmp']);
    });
});
