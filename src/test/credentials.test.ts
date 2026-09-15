import * as assert from 'assert';
import * as vscode from 'vscode';
import { CredentialStore, secretKey, savePasswords } from '../credentials';
import { isAuthFailure } from '../utils/connectOptions';
import { SSHConnection } from '../utils/sshConfig';

/** A SecretStorage that keeps everything in a map. */
function fakeSecrets(): vscode.SecretStorage & { entries: Map<string, string> } {
    const entries = new Map<string, string>();
    const changed = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>();

    return {
        entries,
        onDidChange: changed.event,
        get: async key => entries.get(key),
        store: async (key, value) => void entries.set(key, value),
        delete: async key => void entries.delete(key),
    };
}

const connection = (overrides: Partial<SSHConnection> = {}): SSHConnection => ({
    host: 'web',
    hostname: '10.0.0.5',
    user: 'root',
    ...overrides,
});

/** Runs a test with the save-passwords setting turned on. */
async function withSaving(body: () => Promise<void>): Promise<void> {
    const config = vscode.workspace.getConfiguration('sshMultiConnect');
    await config.update('savePasswords', true, vscode.ConfigurationTarget.Global);
    try {
        await body();
    } finally {
        await config.update('savePasswords', undefined, vscode.ConfigurationTarget.Global);
    }
}

suite('credentials: keys', () => {
    test('keys by what authenticates, not by the alias', () => {
        assert.strictEqual(secretKey(connection()), 'password:root@10.0.0.5:22');
        assert.strictEqual(secretKey(connection({ host: 'renamed' })), 'password:root@10.0.0.5:22');
    });

    test('a different account or port is a different entry', () => {
        assert.notStrictEqual(secretKey(connection({ user: 'admin' })), secretKey(connection()));
        assert.notStrictEqual(secretKey(connection({ port: 2222 })), secretKey(connection()));
    });
});

suite('credentials: storage', () => {
    test('saves nothing while the setting is off', async () => {
        assert.strictEqual(savePasswords(), false);
        const secrets = fakeSecrets();

        await new CredentialStore(secrets).save(connection(), 'hunter2');

        assert.strictEqual(secrets.entries.size, 0);
    });

    test('saves and reads back once the setting is on', async () => {
        const secrets = fakeSecrets();
        const store = new CredentialStore(secrets);

        await withSaving(async () => {
            await store.save(connection(), 'hunter2');
            assert.strictEqual(await store.read(connection()), 'hunter2');
        });
    });

    test('forgets a saved password', async () => {
        const secrets = fakeSecrets();
        const store = new CredentialStore(secrets);

        await withSaving(async () => {
            await store.save(connection(), 'hunter2');
            await store.forget(connection());
            assert.strictEqual(await store.read(connection()), undefined);
        });
    });

    test('reads nothing for a host that has never been saved', async () => {
        assert.strictEqual(await new CredentialStore(fakeSecrets()).read(connection()), undefined);
    });
});

suite('isAuthFailure', () => {
    test('recognises what ssh2 reports for rejected credentials', () => {
        assert.ok(isAuthFailure(Object.assign(new Error('bad'), { level: 'client-authentication' })));
        assert.ok(isAuthFailure(new Error('All configured authentication methods failed')));
        assert.ok(isAuthFailure(new Error('Jump host bastion: Permission denied')));
    });

    test('does not mistake an unreachable host for a bad password', () => {
        assert.ok(!isAuthFailure(Object.assign(new Error('connect ECONNREFUSED'), { level: 'client-socket' })));
        assert.ok(!isAuthFailure(new Error('Timed out while waiting for handshake')));
        assert.ok(!isAuthFailure(undefined));
    });
});
