import * as assert from 'assert';
import {
    OTHER_HOST_ROW,
    destinationRows,
    planRemoteCopy,
    posixBasename,
    posixJoin,
    refuseCopy,
    RemoteEntry,
} from '../utils/remoteCopy';

const file = (path: string, size = 10, mode?: number): RemoteEntry => ({
    path,
    isDirectory: false,
    isSymbolicLink: false,
    size,
    mode,
});

const dir = (path: string): RemoteEntry => ({ path, isDirectory: true, isSymbolicLink: false, size: 0 });

const link = (path: string): RemoteEntry => ({ path, isDirectory: false, isSymbolicLink: true, size: 0 });

/** A listing built from a map of directory to entries. */
const lister = (tree: Record<string, RemoteEntry[]>) => async (path: string) => {
    const entries = tree[path];
    if (!entries) {
        throw new Error('No such directory');
    }
    return entries;
};

suite('remoteCopy: paths', () => {
    test('takes the last segment', () => {
        assert.strictEqual(posixBasename('/srv/www/index.html'), 'index.html');
        assert.strictEqual(posixBasename('/srv/www/'), 'www');
        assert.strictEqual(posixBasename('/'), '');
    });

    test('joins without doubling the separator', () => {
        assert.strictEqual(posixJoin('/srv', 'a'), '/srv/a');
        assert.strictEqual(posixJoin('/', 'a'), '/a');
    });
});

suite('remoteCopy: planning', () => {
    test('copies one file under the destination, keeping its name', async () => {
        const plan = await planRemoteCopy(file('/etc/hosts', 42, 0o644), '/tmp', lister({}));

        assert.deepStrictEqual(plan.steps, [
            { kind: 'file', from: '/etc/hosts', to: '/tmp/hosts', size: 42, mode: 0o644 },
        ]);
        assert.strictEqual(plan.bytes, 42);
    });

    test('creates a folder before the files inside it', async () => {
        const plan = await planRemoteCopy(
            dir('/srv/site'),
            '/backup',
            lister({
                '/srv/site': [dir('/srv/site/css'), file('/srv/site/index.html')],
                '/srv/site/css': [file('/srv/site/css/main.css')],
            })
        );

        assert.deepStrictEqual(
            plan.steps.map(step => `${step.kind} ${step.to}`),
            [
                'directory /backup/site',
                'directory /backup/site/css',
                'file /backup/site/css/main.css',
                'file /backup/site/index.html',
            ]
        );
    });

    test('adds up the bytes of the files, not the folders', async () => {
        const plan = await planRemoteCopy(dir('/a'), '/b', lister({ '/a': [file('/a/one', 100), file('/a/two', 5)] }));

        assert.strictEqual(plan.bytes, 105);
    });

    test('skips a symbolic link rather than following it', async () => {
        const plan = await planRemoteCopy(dir('/a'), '/b', lister({ '/a': [file('/a/real'), link('/a/loop')] }));

        assert.deepStrictEqual(plan.skipped, [{ name: 'loop', reason: 'symbolic link' }]);
        assert.strictEqual(plan.steps.filter(step => step.kind === 'file').length, 1);
    });

    test('reports a folder it cannot read instead of failing the whole copy', async () => {
        const plan = await planRemoteCopy(dir('/a'), '/b', lister({ '/a': [dir('/a/private'), file('/a/readable')] }));

        assert.strictEqual(plan.skipped.length, 1);
        assert.strictEqual(plan.skipped[0].name, 'private');
        assert.ok(plan.steps.some(step => step.to === '/b/a/readable'));
    });
});

suite('remoteCopy: refusing a copy that would eat itself', () => {
    test('refuses a folder into itself', () => {
        assert.ok(refuseCopy('/srv/www', '/srv/www', true));
        assert.ok(refuseCopy('/srv/www', '/srv/www/assets', true));
    });

    test('refuses copying to where it already is', () => {
        assert.ok(refuseCopy('/srv/www/index.html', '/srv/www', true));
    });

    test('allows the same paths when the hosts differ', () => {
        assert.strictEqual(refuseCopy('/srv/www', '/srv/www', false), undefined);
        assert.strictEqual(refuseCopy('/srv/www/index.html', '/srv/www', false), undefined);
    });

    test('allows a sibling folder on the same host', () => {
        assert.strictEqual(refuseCopy('/srv/www', '/backup', true), undefined);
    });

    test('is not fooled by a name that merely starts the same', () => {
        assert.strictEqual(refuseCopy('/srv/www', '/srv/www-old', true), undefined);
    });
});

suite('remoteCopy: choosing destinations', () => {
    const candidate = (host: string, connected: boolean) => ({
        id: host,
        host,
        hostname: `${host}.example`,
        user: 'me',
        connected,
    });

    test('offers live hosts before idle ones', () => {
        const rows = destinationRows([candidate('idle', false), candidate('live', true)], 'source');

        assert.deepStrictEqual(
            rows.filter(row => row.id).map(row => row.label),
            ['live', 'idle']
        );
    });

    test('says an idle host will be connected first', () => {
        const [, row] = destinationRows([candidate('idle', false)], 'source');

        assert.ok(row.detail?.includes('connected first'));
    });

    test('keeps the source in the list, for another folder on the same host', () => {
        const rows = destinationRows([candidate('here', true)], 'here');
        const source = rows.find(row => row.id === 'here');

        assert.ok(source);
        assert.ok(source.detail?.includes('another folder'));
    });

    test('always offers a host that is not in the list', () => {
        const rows = destinationRows([], 'source');
        const other = rows.find(row => row.other);

        assert.ok(other);
        assert.ok(other.label.includes(OTHER_HOST_ROW));
        assert.strictEqual(other.id, undefined);
    });

    test('group headings carry no id, so they cannot be picked', () => {
        const rows = destinationRows([candidate('a', true)], 'source');

        assert.ok(rows.filter(row => row.separator).every(row => row.id === undefined));
    });

    test('sorts by name within a group', () => {
        const rows = destinationRows([candidate('c', true), candidate('a', true), candidate('b', true)], 'source');

        assert.deepStrictEqual(
            rows.filter(row => row.id).map(row => row.label),
            ['a', 'b', 'c']
        );
    });
});
