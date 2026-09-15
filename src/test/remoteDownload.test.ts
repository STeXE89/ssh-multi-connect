import * as assert from 'assert';
import * as path from 'path';
import { localPathFor } from '../remoteDownloadUi';

suite('remoteDownload: where a download lands', () => {
    test('a file saved under its own name goes exactly there', () => {
        assert.strictEqual(localPathFor('/hosts', '/home/me/hosts-copy', false), '/home/me/hosts-copy');
    });

    test('several entries each keep their name inside the chosen folder', () => {
        assert.strictEqual(localPathFor('/one.txt', '/home/me', true), path.join('/home/me', 'one.txt'));
        assert.strictEqual(localPathFor('/two.txt', '/home/me', true), path.join('/home/me', 'two.txt'));
    });

    test('a folder is recreated inside the chosen directory, keeping its name', () => {
        assert.strictEqual(localPathFor('/site', '/home/me', true), path.join('/home/me', 'site'));
    });

    test('everything under a folder keeps its shape', () => {
        assert.strictEqual(
            localPathFor('/site/css/main.css', '/home/me', true),
            path.join('/home/me', 'site', 'css', 'main.css')
        );
    });

    test('builds paths with the local separator, not the remote one', () => {
        const local = localPathFor('/site/css/main.css', path.join('/home', 'me'), true);

        assert.strictEqual(local, path.join('/home', 'me', 'site', 'css', 'main.css'));
    });
});
