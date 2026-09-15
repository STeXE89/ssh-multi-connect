import * as assert from 'assert';
import { summariseSelection, describeSelection } from '../utils/selectionSummary';
import { formatBytes } from '../fileDetailsView';

const file = (name: string, size: number) => ({ name, isDirectory: false, size });
const dir = (name: string) => ({ name, isDirectory: true, size: 0 });

suite('selectionSummary: adding a selection up', () => {
    test('counts files and folders apart', () => {
        const summary = summariseSelection([file('a', 10), dir('b'), file('c', 5)]);

        assert.strictEqual(summary.files, 2);
        assert.strictEqual(summary.folders, 1);
    });

    test('sums the bytes of the files', () => {
        assert.strictEqual(summariseSelection([file('a', 1000), file('b', 24)]).bytes, 1024);
    });

    test('leaves folders out of the total rather than guessing at them', () => {
        assert.strictEqual(summariseSelection([file('a', 100), dir('b')]).bytes, 100);
    });

    test('keeps the names in selection order', () => {
        assert.deepStrictEqual(summariseSelection([file('z', 1), file('a', 1)]).names, ['z', 'a']);
    });

    test('copes with nothing selected', () => {
        assert.deepStrictEqual(summariseSelection([]), { files: 0, folders: 0, bytes: 0, names: [] });
    });
});

suite('selectionSummary: describing it', () => {
    test('gives the count and the size', () => {
        const summary = summariseSelection([file('a', 1024), file('b', 1024)]);

        assert.strictEqual(describeSelection(summary, formatBytes), `2 files, ${formatBytes(2048)}`);
    });

    test('uses the singular for one file', () => {
        assert.ok(describeSelection(summariseSelection([file('a', 1)]), formatBytes).startsWith('1 file,'));
    });

    test('says folders are not measured, rather than reporting them as empty', () => {
        const summary = summariseSelection([dir('a'), dir('b')]);

        assert.strictEqual(describeSelection(summary, formatBytes), '2 folders, not measured');
    });

    test('joins both when the selection mixes them', () => {
        const text = describeSelection(summariseSelection([file('a', 10), dir('b')]), formatBytes);

        assert.ok(text.includes('1 file,'));
        assert.ok(text.includes('1 folder, not measured'));
    });

    test('says so when there is nothing', () => {
        assert.strictEqual(describeSelection(summariseSelection([]), formatBytes), 'Nothing selected');
    });
});
