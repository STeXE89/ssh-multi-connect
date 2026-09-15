import * as assert from 'assert';
import * as vscode from 'vscode';
import { localPathsFromUriList, dropDestination, uploadPath, posixParent, describeUpload } from '../utils/dropTargets';

const parse = (value: string) => vscode.Uri.parse(value, true);

suite('dropTargets: reading a uri-list', () => {
    test('reads the files VS Code hands over', () => {
        const list = ['file:///home/me/a.txt', 'file:///home/me/b.txt'].join('\r\n');

        assert.deepStrictEqual(localPathsFromUriList(list, parse), ['/home/me/a.txt', '/home/me/b.txt']);
    });

    test('ignores comments and blank lines, which the format allows', () => {
        const list = ['# a comment', '', 'file:///home/me/a.txt', '  '].join('\r\n');

        assert.deepStrictEqual(localPathsFromUriList(list, parse), ['/home/me/a.txt']);
    });

    test('drops anything that is not a local file', () => {
        const list = ['https://example.com/a.txt', 'untitled:Untitled-1', 'file:///home/me/a.txt'].join('\n');

        assert.deepStrictEqual(localPathsFromUriList(list, parse), ['/home/me/a.txt']);
    });

    test('survives a line that is not a URI at all', () => {
        assert.deepStrictEqual(localPathsFromUriList('not a uri\nfile:///a', parse), ['/a']);
    });

    test('decodes an escaped name rather than uploading the escapes', () => {
        assert.deepStrictEqual(localPathsFromUriList('file:///home/me/my%20file.txt', parse), ['/home/me/my file.txt']);
    });
});

suite('dropTargets: choosing the destination', () => {
    test('drops into the folder itself', () => {
        assert.strictEqual(dropDestination({ path: '/srv/www', isDirectory: true }, '/'), '/srv/www');
    });

    test('dropping on a file means the folder holding it', () => {
        assert.strictEqual(dropDestination({ path: '/srv/www/index.html', isDirectory: false }, '/'), '/srv/www');
    });

    test('dropping on empty space means the folder on show', () => {
        assert.strictEqual(dropDestination(undefined, '/home/me'), '/home/me');
    });

    test('a file at the top level belongs to the root', () => {
        assert.strictEqual(dropDestination({ path: '/notes.txt', isDirectory: false }, '/'), '/');
    });
});

suite('dropTargets: remote paths', () => {
    test('keeps the file name, under the destination', () => {
        assert.strictEqual(uploadPath('/srv/www', '/home/me/index.html'), '/srv/www/index.html');
    });

    test('does not double the separator at the root', () => {
        assert.strictEqual(uploadPath('/', '/home/me/index.html'), '/index.html');
    });

    test('builds POSIX paths whatever the local separator is', () => {
        assert.ok(!uploadPath('/srv', 'C:\\Users\\me\\a.txt').includes('\\\\'));
    });

    test('walks up a path', () => {
        assert.strictEqual(posixParent('/a/b/c'), '/a/b');
        assert.strictEqual(posixParent('/a/b/'), '/a');
        assert.strictEqual(posixParent('/a'), '/');
        assert.strictEqual(posixParent('/'), '/');
    });
});

suite('dropTargets: describing an upload', () => {
    test('names a single file', () => {
        assert.strictEqual(describeUpload(['/home/me/a.txt'], '/srv'), 'Uploading "a.txt" to /srv');
    });

    test('counts several', () => {
        assert.strictEqual(describeUpload(['/a', '/b', '/c'], '/srv'), 'Uploading 3 files to /srv');
    });
});
