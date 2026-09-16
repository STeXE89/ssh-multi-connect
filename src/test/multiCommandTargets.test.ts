import * as assert from 'assert';
import { selectedTargets, splitTerminalName, missingTerminals } from '../utils/multiCommandTargets';

const conn = (id: string, host = id, user?: string) => ({ id, host, user });

suite('multiCommandTargets: picking hosts', () => {
    test('keeps the panel order, not the order they were ticked', () => {
        const connections = [conn('a'), conn('b'), conn('c')];

        assert.deepStrictEqual(
            selectedTargets(connections, ['c', 'a']).map(target => target.id),
            ['a', 'c']
        );
    });

    test('ignores an id that is no longer connected', () => {
        assert.deepStrictEqual(
            selectedTargets([conn('a')], ['a', 'gone']).map(t => t.id),
            ['a']
        );
    });

    test('selects nothing when nothing is ticked', () => {
        assert.deepStrictEqual(selectedTargets([conn('a')], []), []);
    });
});

suite('multiCommandTargets: terminal names', () => {
    test('names a terminal after the account', () => {
        assert.strictEqual(splitTerminalName(conn('c1', 'donatello', 'don')), 'don@donatello · multi');
    });

    test('copes with a connection that has no user', () => {
        assert.strictEqual(splitTerminalName(conn('c1', 'donatello')), 'donatello · multi');
    });

    test('never collides with the name a connection terminal uses', () => {
        const connection = conn('c1', 'donatello', 'don');

        assert.notStrictEqual(splitTerminalName(connection), `${connection.user}@${connection.host}`);
    });
});

suite('multiCommandTargets: reusing the group', () => {
    test('opens a terminal only for hosts that have none', () => {
        const targets = [conn('a'), conn('b'), conn('c')];

        assert.deepStrictEqual(
            missingTerminals(targets, new Set(['b'])).map(target => target.id),
            ['a', 'c']
        );
    });

    test('opens nothing when the group already covers the selection', () => {
        assert.deepStrictEqual(missingTerminals([conn('a')], new Set(['a'])), []);
    });
});
