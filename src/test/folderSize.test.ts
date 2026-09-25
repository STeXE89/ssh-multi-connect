import * as assert from 'assert';
import { parseFolderSize } from '../utils/folderSize';

suite('folderSize', () => {
    test('takes the size du printed', () => {
        assert.strictEqual(parseFolderSize('4.0K\t/etc/fonts\n', ''), '4.0K');
    });

    test('says so when part of the tree could not be read', () => {
        // du exits non-zero here, and still prints a total for the rest. That
        // total is smaller than the folder really is.
        const stderr = "du: cannot read directory '/etc/ssl/private': Permission denied\n";

        assert.strictEqual(parseFolderSize('12M\t/etc\n', stderr), '12M or more');
    });

    test('reports nothing rather than a wrong number when there is no output', () => {
        assert.strictEqual(parseFolderSize('', 'du: command not found'), 'Unavailable');
        assert.strictEqual(parseFolderSize('   \n', ''), 'Unavailable');
    });

    test('ignores stderr that is not about unreadable folders', () => {
        assert.strictEqual(parseFolderSize('2.0G\t/var\n', 'du: warning: something else'), '2.0G');
    });
});
