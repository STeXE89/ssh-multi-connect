import * as assert from 'assert';
import { rememberCommand, readHistory, HISTORY_LIMIT } from '../utils/commandHistory';

suite('commandHistory: remembering', () => {
    test('puts the newest first', () => {
        assert.deepStrictEqual(rememberCommand(['df -h'], 'uptime'), ['uptime', 'df -h']);
    });

    test('moves a repeat to the front rather than duplicating it', () => {
        assert.deepStrictEqual(rememberCommand(['df -h', 'uptime'], 'uptime'), ['uptime', 'df -h']);
    });

    test('trims what it stores', () => {
        assert.deepStrictEqual(rememberCommand([], '  uptime  '), ['uptime']);
    });

    test('ignores an empty command', () => {
        assert.deepStrictEqual(rememberCommand(['uptime'], '   '), ['uptime']);
    });

    test('keeps the list to its limit', () => {
        const many = Array.from({ length: HISTORY_LIMIT }, (_, index) => `command-${index}`);
        const updated = rememberCommand(many, 'newest');

        assert.strictEqual(updated.length, HISTORY_LIMIT);
        assert.strictEqual(updated[0], 'newest');
        assert.ok(!updated.includes(`command-${HISTORY_LIMIT - 1}`));
    });

    test('does not change the list it was given', () => {
        const original = ['uptime'];
        rememberCommand(original, 'df -h');

        assert.deepStrictEqual(original, ['uptime']);
    });
});

suite('commandHistory: reading it back', () => {
    test('takes a stored list', () => {
        assert.deepStrictEqual(readHistory(['uptime', 'df -h']), ['uptime', 'df -h']);
    });

    test('empties rather than breaks on state of the wrong shape', () => {
        assert.deepStrictEqual(readHistory(undefined), []);
        assert.deepStrictEqual(readHistory('uptime'), []);
        assert.deepStrictEqual(readHistory({ commands: [] }), []);
    });

    test('drops entries that are not commands', () => {
        assert.deepStrictEqual(readHistory(['uptime', 42, null, '', '  ', 'df -h']), ['uptime', 'df -h']);
    });
});
