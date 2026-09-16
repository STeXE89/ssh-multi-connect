import * as assert from 'assert';
import { accountLabel, hopPasswordPrompt, hopPassphrasePrompt, hostPasswordPrompt } from '../utils/authPrompts';

suite('authPrompts: naming the account', () => {
    test('names it the way ssh does', () => {
        assert.strictEqual(accountLabel('don', 'donatello', 22), 'don@donatello:22');
    });

    test('does not leave the account blank when there is none', () => {
        assert.strictEqual(accountLabel('', 'donatello', 2222), '?@donatello:2222');
    });
});

suite('authPrompts: a jump host', () => {
    test('says it is a jump host and where the connection is going', () => {
        const prompt = hopPasswordPrompt('don@donatello:22', 0, 1, 'darwin-via-donatello');

        assert.strictEqual(prompt.title, 'Jump host');
        assert.strictEqual(prompt.placeHolder, 'Password for don@donatello:22');
        assert.strictEqual(prompt.prompt, 'Jump host, on the way to darwin-via-donatello');
    });

    test('counts the hops when there is more than one', () => {
        assert.strictEqual(hopPasswordPrompt('a@b:22', 0, 2, 'target').title, 'Jump host 1 of 2');
        assert.strictEqual(hopPasswordPrompt('a@b:22', 1, 2, 'target').title, 'Jump host 2 of 2');
    });

    test('a passphrase prompt names the key and still says which host it unlocks', () => {
        const prompt = hopPassphrasePrompt('don@donatello:22', '/home/me/.ssh/id_ed25519', 0, 1, 'darwin');

        assert.strictEqual(prompt.placeHolder, 'Passphrase for /home/me/.ssh/id_ed25519');
        assert.ok(prompt.prompt.includes('don@donatello:22'));
        assert.ok(prompt.prompt.includes('darwin'));
    });
});

suite('authPrompts: the destination host', () => {
    test('is told apart from the jump hosts when there are some', () => {
        const prompt = hostPasswordPrompt('dar@darwin:22', 'darwin-via-donatello', 'donatello');

        assert.strictEqual(prompt.title, 'Destination: darwin-via-donatello');
        assert.strictEqual(prompt.placeHolder, 'Password for dar@darwin:22');
        assert.strictEqual(prompt.prompt, 'Reached through donatello');
    });

    test('stays plain for a direct connection, which needs no explaining', () => {
        const prompt = hostPasswordPrompt('don@donatello:22', 'donatello');

        assert.strictEqual(prompt.title, undefined);
        assert.strictEqual(prompt.placeHolder, 'Password for don@donatello:22');
        assert.strictEqual(prompt.prompt, 'donatello');
    });

    test('never shows the same wording for a hop and the destination', () => {
        const hop = hopPasswordPrompt('a@b:22', 0, 1, 'target');
        const host = hostPasswordPrompt('c@d:22', 'target', 'b');

        assert.notStrictEqual(hop.title, host.title);
        assert.notStrictEqual(hop.prompt, host.prompt);
    });
});
