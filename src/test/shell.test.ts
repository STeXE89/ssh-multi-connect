import * as assert from 'assert';
import { execFileSync } from 'child_process';
import { quote, quoteAll, isValidHostname } from '../utils/shell';

/**
 * Runs a command line through a real shell and returns the arguments it saw.
 * This proves the quoting holds up against `sh` rather than against a regex.
 */
function argvThroughShell(commandLine: string): string[] {
    // NUL-separated, because a test value may itself contain a newline.
    const output = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${commandLine}`], {
        encoding: 'utf-8',
    });
    return output.split('\0').slice(0, -1);
}

const HAS_POSIX_SHELL = process.platform !== 'win32';

suite('shell: quote', () => {
    test('quotes a plain value', () => {
        assert.strictEqual(quote('hello'), `'hello'`);
    });

    test('quotes an empty value', () => {
        assert.strictEqual(quote(''), `''`);
    });

    test('survives a round trip through sh for hostile values', function () {
        if (!HAS_POSIX_SHELL) {
            this.skip();
        }

        const hostile = [
            'plain',
            'with space',
            'semi;colon',
            '$(id)',
            '`id`',
            "single'quote",
            'double"quote',
            '&& rm -rf /',
            'new\nline',
            '*',
            '~/path',
            '$HOME',
            'back\\slash',
        ];

        assert.deepStrictEqual(argvThroughShell(quoteAll(hostile)), hostile);
    });

    test('does not let a value break out into a second command', function () {
        if (!HAS_POSIX_SHELL) {
            this.skip();
        }

        // The classic injection: a value that closes the quote and appends a
        // command. Quoted properly, sh must treat it as one literal argument.
        const payload = `'; echo INJECTED; '`;

        assert.deepStrictEqual(argvThroughShell(quote(payload)), [payload]);
    });

    test('quoteAll joins with spaces', () => {
        assert.strictEqual(quoteAll(['a', 'b']), `'a' 'b'`);
    });
});

suite('shell: isValidHostname', () => {
    test('accepts hostnames, IPv4 and bracketed IPv6', () => {
        assert.ok(isValidHostname('example.com'));
        assert.ok(isValidHostname('web-01.internal'));
        assert.ok(isValidHostname('10.0.0.5'));
        assert.ok(isValidHostname('[2001:db8::1]'));
    });

    test('rejects shell metacharacters', () => {
        assert.ok(!isValidHostname('host;id'));
        assert.ok(!isValidHostname('host$(id)'));
        assert.ok(!isValidHostname('host name'));
        assert.ok(!isValidHostname('host`id`'));
        assert.ok(!isValidHostname(''));
    });

    test('rejects an over-long name', () => {
        assert.ok(!isValidHostname('a'.repeat(254)));
    });
});
