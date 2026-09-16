import * as assert from 'assert';
import { planMove, refuseMove, describeMove } from '../utils/remoteMove';

const file = (path: string) => ({ path, isDirectory: false });
const dir = (path: string) => ({ path, isDirectory: true });

suite('remoteMove: planning', () => {
    test('moves a file under the folder it was dropped on', () => {
        const plan = planMove([file('/home/me/notes.txt')], '/srv/www');

        assert.deepStrictEqual(plan.moves, [{ from: '/home/me/notes.txt', to: '/srv/www/notes.txt' }]);
        assert.deepStrictEqual(plan.skipped, []);
    });

    test('moves several at once', () => {
        const plan = planMove([file('/a/one'), file('/a/two')], '/b');

        assert.deepStrictEqual(
            plan.moves.map(move => move.to),
            ['/b/one', '/b/two']
        );
    });

    test('leaves the ones it cannot move, and moves the rest', () => {
        const plan = planMove([file('/srv/www/index.html'), file('/home/me/a.txt')], '/srv/www');

        assert.deepStrictEqual(plan.moves, [{ from: '/home/me/a.txt', to: '/srv/www/a.txt' }]);
        assert.deepStrictEqual(plan.skipped, [{ name: 'index.html', reason: 'already there' }]);
    });
});

suite('remoteMove: drops that cannot be made', () => {
    test('dropping something where it already is does nothing', () => {
        assert.strictEqual(refuseMove(file('/srv/www/index.html'), '/srv/www'), 'already there');
    });

    test('refuses a folder into itself or its own children', () => {
        assert.ok(refuseMove(dir('/srv/www'), '/srv/www'));
        assert.ok(refuseMove(dir('/srv/www'), '/srv/www/assets'));
    });

    test('is not fooled by a sibling whose name starts the same', () => {
        assert.strictEqual(refuseMove(dir('/srv/www'), '/srv/www-old'), undefined);
    });

    test('allows a folder into an unrelated one', () => {
        assert.strictEqual(refuseMove(dir('/srv/www'), '/backup'), undefined);
    });

    test('allows a file back into a folder it is not in', () => {
        assert.strictEqual(refuseMove(file('/tmp/a.txt'), '/srv'), undefined);
    });
});

suite('remoteMove: describing it', () => {
    test('names a single entry', () => {
        const plan = planMove([file('/a/one.txt')], '/b');

        assert.strictEqual(describeMove(plan, '/b'), 'Moving "one.txt" to /b');
    });

    test('counts several', () => {
        const plan = planMove([file('/a/one'), file('/a/two')], '/b');

        assert.strictEqual(describeMove(plan, '/b'), 'Moving 2 entries to /b');
    });
});
