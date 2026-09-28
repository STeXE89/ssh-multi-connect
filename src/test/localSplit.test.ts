import * as assert from 'assert';
import { isLocalSplitOfRemote } from '../utils/localSplit';

const local = { ours: false, hasPty: false };
const remote = { ours: true, hasPty: true };

suite('localSplit', () => {
    test('a local shell opening straight after a remote one is worth explaining', () => {
        assert.ok(isLocalSplitOfRemote(local, true, false));
    });

    test('says nothing when no remote shell was being looked at', () => {
        // A local terminal opened from the panel or the palette is just that.
        assert.ok(!isLocalSplitOfRemote(local, false, false));
    });

    test('says nothing about one of our own shells', () => {
        assert.ok(!isLocalSplitOfRemote(remote, true, false));
    });

    test("says nothing about another extension's pty terminal", () => {
        assert.ok(!isLocalSplitOfRemote({ ours: false, hasPty: true }, true, false));
    });

    test('says it once and not again', () => {
        assert.ok(!isLocalSplitOfRemote(local, true, true));
    });
});
