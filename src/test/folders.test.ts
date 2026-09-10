import * as assert from 'assert';
import {
    normalizeFolderPath,
    collectFolderPaths,
    isSelfNesting,
    movedFolderPath,
    reparentTag,
    countInFolder,
} from '../utils/folders';
import { destinationOf } from '../connectionDragAndDrop';
import { SSHConnectionTreeItem, SSHFolderTreeItem, ExtendedSSHConnection } from '../sshConnection';

function connection(overrides: Partial<ExtendedSSHConnection> = {}): ExtendedSSHConnection {
    return { id: 'web', host: 'web', hostname: '10.0.0.5', ...overrides };
}

suite('folders: normalizeFolderPath', () => {
    test('keeps a clean path', () => {
        assert.strictEqual(normalizeFolderPath('A/B'), 'A/B');
    });

    test('collapses stray slashes', () => {
        assert.strictEqual(normalizeFolderPath('/A//B/'), 'A/B');
    });

    test('treats empty and whitespace-only paths as the root', () => {
        assert.strictEqual(normalizeFolderPath(''), undefined);
        assert.strictEqual(normalizeFolderPath('/'), undefined);
        assert.strictEqual(normalizeFolderPath(undefined), undefined);
    });
});

suite('folders: collectFolderPaths', () => {
    test('includes every parent of a nested tag', () => {
        // A/B/C is three valid destinations, not one.
        assert.deepStrictEqual(collectFolderPaths(['A/B/C']), ['A', 'A/B', 'A/B/C']);
    });

    test('de-duplicates shared parents and sorts', () => {
        assert.deepStrictEqual(collectFolderPaths(['Prod/EU', 'Prod/US', 'Dev']), [
            'Dev',
            'Prod',
            'Prod/EU',
            'Prod/US',
        ]);
    });

    test('ignores connections with no folder', () => {
        assert.deepStrictEqual(collectFolderPaths([undefined, '', 'A']), ['A']);
    });

    test('returns nothing when no folders are in use', () => {
        assert.deepStrictEqual(collectFolderPaths([undefined, undefined]), []);
    });
});

suite('folders: moving a folder', () => {
    test('rejects moving a folder into itself', () => {
        assert.strictEqual(isSelfNesting('A', 'A'), true);
        assert.strictEqual(isSelfNesting('A', 'A/B'), true);
    });

    test('allows unrelated destinations and the root', () => {
        assert.strictEqual(isSelfNesting('A', 'B'), false);
        assert.strictEqual(isSelfNesting('A', undefined), false);
        // A sibling whose name merely starts the same is not nesting.
        assert.strictEqual(isSelfNesting('A', 'AB'), false);
    });

    test('computes the new path under a parent', () => {
        assert.strictEqual(movedFolderPath('A/B', 'X'), 'X/B');
        assert.strictEqual(movedFolderPath('A/B', undefined), 'B');
    });

    test('rewrites the folder tag and its descendants', () => {
        assert.strictEqual(reparentTag('A', 'A', 'X/A'), 'X/A');
        assert.strictEqual(reparentTag('A/B/C', 'A', 'X/A'), 'X/A/B/C');
    });

    test('leaves unrelated tags alone', () => {
        assert.strictEqual(reparentTag('B', 'A', 'X/A'), undefined);
        assert.strictEqual(reparentTag('AB', 'A', 'X/A'), undefined);
        assert.strictEqual(reparentTag(undefined, 'A', 'X/A'), undefined);
    });
});

suite('drag and drop: destinationOf', () => {
    test('a folder is its own destination', () => {
        assert.strictEqual(destinationOf(new SSHFolderTreeItem('Prod/EU')), 'Prod/EU');
    });

    test('a connection contributes its folder', () => {
        const item = new SSHConnectionTreeItem(connection({ vFolderTag: 'Prod' }), false);

        assert.strictEqual(destinationOf(item), 'Prod');
    });

    test('a connection at the root means the root', () => {
        assert.strictEqual(destinationOf(new SSHConnectionTreeItem(connection(), false)), undefined);
    });

    test('empty space means the root', () => {
        assert.strictEqual(destinationOf(undefined), undefined);
    });
});

suite('folders: countInFolder', () => {
    test('counts connections directly in the folder', () => {
        assert.strictEqual(countInFolder(['Prod', 'Prod', 'Dev'], 'Prod'), 2);
    });

    test('includes connections in subfolders', () => {
        assert.strictEqual(countInFolder(['Prod', 'Prod/EU', 'Prod/EU/A', 'Dev'], 'Prod'), 3);
    });

    test('does not count a sibling with a shared prefix', () => {
        // "ProdX" is not inside "Prod".
        assert.strictEqual(countInFolder(['Prod', 'ProdX'], 'Prod'), 1);
    });

    test('ignores connections with no folder', () => {
        assert.strictEqual(countInFolder([undefined, 'Prod'], 'Prod'), 1);
    });

    test('returns zero for an unknown folder', () => {
        assert.strictEqual(countInFolder(['Prod'], 'Nope'), 0);
    });
});
