import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildSearchCommand, parseSearchOutput, describeHit } from '../utils/remoteSearch';

const request = (overrides: Partial<Parameters<typeof buildSearchCommand>[0]> = {}) =>
    buildSearchCommand({
        pattern: 'needle',
        directory: '/var/log',
        ignoreCase: true,
        regex: false,
        limit: 50,
        ...overrides,
    });

suite('remoteSearch: building the command', () => {
    test('searches the folder for the pattern', () => {
        const command = request();

        assert.ok(command.startsWith('grep '));
        assert.ok(command.includes("-e 'needle'"));
        assert.ok(command.includes("-- '/var/log'"));
    });

    test('treats the pattern as plain text unless a regex was asked for', () => {
        assert.ok(request().includes(' -F '));
        assert.ok(!request({ regex: true }).includes(' -F '));
    });

    test('honours case sensitivity', () => {
        assert.ok(request({ ignoreCase: true }).includes(' -i '));
        assert.ok(!request({ ignoreCase: false }).includes(' -i '));
    });

    test('caps the results at both ends, so a wide match cannot flood back', () => {
        const command = request({ limit: 25 });

        assert.ok(command.includes('-m 25'));
        assert.ok(command.includes('head -n 25'));
    });

    test('skips binary files and silences unreadable folders', () => {
        const command = request();

        assert.ok(command.includes('--binary-files=without-match'));
        assert.ok(command.includes('2>/dev/null'));
    });

    test('quotes a pattern that would otherwise run as a command', () => {
        const command = request({ pattern: '$(reboot)' });

        assert.ok(command.includes("'$(reboot)'"));
        assert.ok(!command.includes('-e $(reboot)'));
    });

    test('survives a pattern containing a quote', () => {
        const command = request({ pattern: "it's; rm -rf /" });

        // The quote is escaped, so nothing after it is read as shell syntax.
        assert.ok(!/-e 'it's;/.test(command));
    });

    test('the command it builds really is one command to a shell', () => {
        // Proven rather than asserted: a hostile pattern must leave no trace
        // beyond the file grep writes nothing to.
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
        const witness = path.join(directory, 'pwned');
        fs.writeFileSync(path.join(directory, 'haystack.txt'), 'nothing to see\n');

        const command = buildSearchCommand({
            pattern: `x'; touch ${witness}; echo '`,
            directory,
            ignoreCase: false,
            regex: false,
            limit: 10,
        });

        execFileSync('sh', ['-c', command], { encoding: 'utf-8' });

        assert.ok(!fs.existsSync(witness), 'the pattern escaped its quoting and ran');
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('finds what it is asked to find, run against a real grep', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
        fs.writeFileSync(path.join(directory, 'a.txt'), 'first line\nthe NEEDLE is here\nlast\n');

        const output = execFileSync(
            'sh',
            ['-c', buildSearchCommand({ pattern: 'needle', directory, ignoreCase: true, regex: false, limit: 10 })],
            { encoding: 'utf-8' }
        );
        const [hit] = parseSearchOutput(output);

        assert.strictEqual(hit.line, 2);
        assert.strictEqual(hit.preview, 'the NEEDLE is here');
        assert.ok(hit.path.endsWith('a.txt'));
        fs.rmSync(directory, { recursive: true, force: true });
    });
});

suite('remoteSearch: reading the output', () => {
    test('takes the path, the line and the text', () => {
        assert.deepStrictEqual(parseSearchOutput('/etc/hosts:3:127.0.0.1 localhost'), [
            { path: '/etc/hosts', line: 3, preview: '127.0.0.1 localhost' },
        ]);
    });

    test('copes with a colon in the path', () => {
        const [hit] = parseSearchOutput('/srv/odd:name/file.txt:7:match here');

        assert.strictEqual(hit.path, '/srv/odd:name/file.txt');
        assert.strictEqual(hit.line, 7);
    });

    test('copes with a colon in the matching text', () => {
        const [hit] = parseSearchOutput('/etc/fstab:2:UUID=x / ext4 defaults 0:1');

        assert.strictEqual(hit.preview, 'UUID=x / ext4 defaults 0:1');
    });

    test('skips lines that are not matches, such as an error that slipped through', () => {
        const hits = parseSearchOutput('grep: /root: Permission denied\n/etc/hosts:1:localhost\n');

        assert.strictEqual(hits.length, 1);
        assert.strictEqual(hits[0].path, '/etc/hosts');
    });

    test('returns nothing for empty output, which is how grep says it found nothing', () => {
        assert.deepStrictEqual(parseSearchOutput(''), []);
    });

    test('trims a very long line rather than filling the picker with it', () => {
        const [hit] = parseSearchOutput(`/a:1:${'x'.repeat(500)}`);

        assert.ok(hit.preview.length <= 200);
    });
});

suite('remoteSearch: describing a hit', () => {
    test('leads with the file and line, which is what is being chosen', () => {
        const described = describeHit({ path: '/srv/www/index.html', line: 12, preview: '<title>' }, '/srv');

        assert.strictEqual(described.label, 'index.html:12');
        assert.strictEqual(described.description, '<title>');
    });

    test('shows the folder relative to what was searched', () => {
        const described = describeHit({ path: '/srv/www/css/a.css', line: 1, preview: 'x' }, '/srv');

        assert.strictEqual(described.detail, '/www/css');
    });

    test('shows the whole folder when the search was rooted at /', () => {
        const described = describeHit({ path: '/etc/ssh/sshd_config', line: 1, preview: 'x' }, '/');

        assert.strictEqual(described.detail, '/etc/ssh');
    });

    test('copes with a file at the root', () => {
        const described = describeHit({ path: '/notes.txt', line: 1, preview: 'x' }, '/');

        assert.strictEqual(described.label, 'notes.txt:1');
        assert.strictEqual(described.detail, '/');
    });
});
