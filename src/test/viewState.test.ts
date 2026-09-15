import * as assert from 'assert';
import { remoteViewAfterDisconnect } from '../utils/viewState';

suite('remoteViewAfterDisconnect', () => {
    test('leaves the view alone when another host is on show', () => {
        // Disconnecting B while A's files are up must not disturb A.
        assert.deepStrictEqual(remoteViewAfterDisconnect('b', 'a', 'a', ['a']), { action: 'keep' });
    });

    test('switches when the closed host was the one on show', () => {
        assert.deepStrictEqual(remoteViewAfterDisconnect('b', 'b', 'a', ['a']), {
            action: 'show',
            connectionId: 'a',
        });
    });

    test('switches when the closed host was the selected one', () => {
        assert.deepStrictEqual(remoteViewAfterDisconnect('b', undefined, 'b', ['a']), {
            action: 'show',
            connectionId: 'a',
        });
    });

    test('acts on the view even when the selection points elsewhere', () => {
        // Connecting a second host swaps the view without changing the
        // selection, so the two disagree and only the view matters here.
        assert.deepStrictEqual(remoteViewAfterDisconnect('b', 'b', 'a', ['a', 'c']), {
            action: 'show',
            connectionId: 'a',
        });
    });

    test('clears the view when nothing is left connected', () => {
        assert.deepStrictEqual(remoteViewAfterDisconnect('b', 'b', 'b', []), { action: 'clear' });
    });

    test('never offers the host that just closed', () => {
        // The list can still name it, since it is read before the tree updates.
        assert.deepStrictEqual(remoteViewAfterDisconnect('b', 'b', 'b', ['b']), { action: 'clear' });
        assert.deepStrictEqual(remoteViewAfterDisconnect('b', 'b', 'b', ['b', 'c']), {
            action: 'show',
            connectionId: 'c',
        });
    });

    test('keeps the view when the closed host was neither shown nor selected', () => {
        assert.deepStrictEqual(remoteViewAfterDisconnect('c', 'a', 'b', ['a', 'b']), { action: 'keep' });
    });
});
