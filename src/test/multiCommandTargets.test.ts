import * as assert from 'assert';
import { selectedTargets, splitTerminalName, missingTerminals, nextTerminalName } from '../utils/multiCommandTargets';

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

suite('multiCommandTargets: naming another terminal', () => {
    test('uses the plain name when the host has none open', () => {
        assert.strictEqual(nextTerminalName('don@donatello', []), 'don@donatello');
    });

    test('numbers the second, since VS Code will happily show two alike', () => {
        assert.strictEqual(nextTerminalName('don@donatello', ['don@donatello']), 'don@donatello (2)');
    });

    test('keeps counting past the second', () => {
        const open = ['don@donatello', 'don@donatello (2)', 'don@donatello (3)'];

        assert.strictEqual(nextTerminalName('don@donatello', open), 'don@donatello (4)');
    });

    test('fills a gap left by a closed terminal', () => {
        const open = ['don@donatello', 'don@donatello (3)'];

        assert.strictEqual(nextTerminalName('don@donatello', open), 'don@donatello (2)');
    });

    test('is not confused by another host whose name starts the same', () => {
        assert.strictEqual(nextTerminalName('don@don', ['don@donatello']), 'don@don');
    });
});

suite('multiCommandTargets: finding a host among open terminals', () => {
    // The provider picks a parent to split from by matching these same shapes,
    // so the naming has to make a host's terminals recognisable.
    const belongsTo = (base: string, name: string) => name === base || name.startsWith(`${base} (`);

    test('recognises the hostterminal and its numbered siblings', () => {
        assert.ok(belongsTo('don@donatello', nextTerminalName('don@donatello', [])));
        assert.ok(belongsTo('don@donatello', nextTerminalName('don@donatello', ['don@donatello'])));
    });

    test('does not claim a multi-command pane, which is a different group', () => {
        assert.ok(!belongsTo('don@donatello', splitTerminalName({ id: 'c', host: 'donatello', user: 'don' })));
    });

    test('does not claim another host whose name merely starts the same', () => {
        assert.ok(!belongsTo('don@don', 'don@donatello'));
    });
});
