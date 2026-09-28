import * as assert from 'assert';
import * as path from 'path';
import { expandHome, resolveConfigPath } from '../utils/paths';
import { ConfigReader, flattenConfig, hostOrigins, expandGlob, splitPatterns } from '../utils/sshConfigInclude';

// ssh_config lives on this machine, so these are local paths: C:\home\me on
// Windows, /home/me elsewhere. Building them the way the code does keeps the
// fake filesystem's keys and the paths it is asked for in the same spelling.
const ROOT = path.parse(process.cwd()).root;
const HOME = path.join(ROOT, 'home', 'me');
const SSH = path.join(HOME, '.ssh');

/**
 * A filesystem built from a map of paths to content.
 *
 * Both separators are accepted, as the real one on Windows does: a path built
 * by `path.join` arrives with backslashes, and one built while expanding a
 * glob with forward slashes, and they mean the same file.
 */
function reader(files: Record<string, string>): ConfigReader {
    const slash = (file: string) => file.replace(/\\/g, '/');
    const byPath = new Map(Object.entries(files).map(([file, content]) => [slash(file), content]));

    return {
        read: file => byPath.get(slash(file)),
        list: directory => {
            const prefix = `${slash(directory)}/`;
            const entries = [...byPath.keys()]
                .filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
                .map(file => file.slice(prefix.length));
            return entries.length > 0 ? entries : undefined;
        },
    };
}

const text = (lines: ReturnType<typeof flattenConfig>) => lines.map(line => line.text).join('\n');

suite('paths: expanding ~', () => {
    test('expands a leading ~/', () => {
        assert.strictEqual(expandHome('~/.ssh/id_ed25519', HOME), path.join(HOME, '.ssh', 'id_ed25519'));
    });

    test('expands a bare ~', () => {
        assert.strictEqual(expandHome('~', HOME), HOME);
    });

    test('leaves an absolute path alone', () => {
        assert.strictEqual(expandHome('/etc/ssh/key', HOME), '/etc/ssh/key');
    });

    test('does not touch another account, which it cannot resolve', () => {
        assert.strictEqual(expandHome('~root/.ssh/key', HOME), '~root/.ssh/key');
    });

    test('does not mistake a ~ inside a path for a home directory', () => {
        assert.strictEqual(expandHome('/etc/back~up/key', HOME), '/etc/back~up/key');
    });

    test('resolves a relative path against the config directory, as ssh does', () => {
        assert.strictEqual(resolveConfigPath('config.d/work', SSH, HOME), path.join(SSH, 'config.d', 'work'));
        assert.strictEqual(resolveConfigPath('~/keys/work', SSH, HOME), path.join(HOME, 'keys', 'work'));
        assert.strictEqual(resolveConfigPath('/etc/ssh/work', SSH, HOME), '/etc/ssh/work');
    });
});

suite('sshConfigInclude: following Include', () => {
    test('pulls an included file in where the directive sits', () => {
        const lines = flattenConfig(
            path.join(SSH, 'config'),
            reader({
                [path.join(SSH, 'config')]: ['Host first', '  HostName 1.1.1.1', 'Include work', 'Host last'].join(
                    '\n'
                ),
                [path.join(SSH, 'work')]: 'Host work\n  HostName 2.2.2.2',
            }),
            SSH,
            HOME
        );

        assert.deepStrictEqual(text(lines).split('\n'), [
            'Host first',
            '  HostName 1.1.1.1',
            'Host work',
            '  HostName 2.2.2.2',
            'Host last',
        ]);
    });

    test('expands a glob, in a stable order', () => {
        const lines = flattenConfig(
            path.join(SSH, 'config'),
            reader({
                [path.join(SSH, 'config')]: 'Include config.d/*',
                [path.join(SSH, 'config.d', 'b')]: 'Host b',
                [path.join(SSH, 'config.d', 'a')]: 'Host a',
            }),
            SSH,
            HOME
        );

        assert.deepStrictEqual(text(lines).split('\n'), ['Host a', 'Host b']);
    });

    test('follows an include inside an included file', () => {
        const lines = flattenConfig(
            path.join(SSH, 'config'),
            reader({
                [path.join(SSH, 'config')]: 'Include one',
                [path.join(SSH, 'one')]: 'Include two',
                [path.join(SSH, 'two')]: 'Host deep',
            }),
            SSH,
            HOME
        );

        assert.strictEqual(text(lines), 'Host deep');
    });

    test('a file including itself stops instead of hanging', () => {
        const lines = flattenConfig(
            path.join(SSH, 'config'),
            reader({ [path.join(SSH, 'config')]: 'Host a\nInclude config' }),
            SSH,
            HOME
        );

        assert.strictEqual(text(lines), 'Host a');
    });

    test('a missing include is skipped rather than hiding every host', () => {
        const lines = flattenConfig(
            path.join(SSH, 'config'),
            reader({ [path.join(SSH, 'config')]: 'Include gone\nHost still-here' }),
            SSH,
            HOME
        );

        assert.strictEqual(text(lines), 'Host still-here');
    });

    test('reads several patterns on one line', () => {
        assert.deepStrictEqual(splitPatterns('a b "with space" c'), ['a', 'b', 'with space', 'c']);
    });

    test('accepts the Key=Value form, as ssh does', () => {
        const lines = flattenConfig(
            path.join(SSH, 'config'),
            reader({ [path.join(SSH, 'config')]: 'Include=work', [path.join(SSH, 'work')]: 'Host work' }),
            SSH,
            HOME
        );

        assert.strictEqual(text(lines), 'Host work');
    });
});

suite('sshConfigInclude: globbing', () => {
    const files = reader({
        '/c/one.conf': '',
        '/c/two.conf': '',
        '/c/notes.txt': '',
        '/c/.hidden.conf': '',
    });

    test('matches a suffix', () => {
        assert.deepStrictEqual(expandGlob('/c/*.conf', files), ['/c/one.conf', '/c/two.conf']);
    });

    test('skips dotfiles, as a shell does', () => {
        assert.ok(!expandGlob('/c/*', files).includes('/c/.hidden.conf'));
    });

    test('matches a single character with ?', () => {
        assert.deepStrictEqual(expandGlob('/c/?ne.conf', files), ['/c/one.conf']);
    });

    test('passes a plain path through untouched', () => {
        assert.deepStrictEqual(expandGlob('/c/one.conf', files), ['/c/one.conf']);
    });

    test('yields nothing when a glob matches nothing', () => {
        assert.deepStrictEqual(expandGlob('/c/*.none', files), []);
    });
});

suite('sshConfigInclude: where a host came from', () => {
    test('records the file each host is defined in', () => {
        const origins = hostOrigins([
            { text: 'Host main', file: '/c/config' },
            { text: '  HostName 1.1.1.1', file: '/c/config' },
            { text: 'Host work', file: '/c/work' },
        ]);

        assert.strictEqual(origins.get('main')?.file, '/c/config');
        assert.strictEqual(origins.get('work')?.file, '/c/work');
        assert.strictEqual(origins.get('main')?.spansIncludes, false);
    });

    test('flags a block that pulls in another file, which must not be rewritten', () => {
        const origins = hostOrigins([
            { text: 'Host mixed', file: '/c/config' },
            { text: '  User root', file: '/c/common' },
        ]);

        assert.strictEqual(origins.get('mixed')?.spansIncludes, true);
    });
});
