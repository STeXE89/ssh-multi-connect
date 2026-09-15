/**
 * Storage for the passwords the user chooses to keep.
 *
 * Passwords live in `SecretStorage`, which is the OS keychain on every
 * supported platform; nothing is written to ssh_config, to settings, or to
 * this extension's own state. Saving is off by default, so a password is only
 * kept once the user has asked for that.
 */

import * as vscode from 'vscode';
import { SSHConnection, SSH_DEFAULT_PORT } from './utils/sshConfig';

/**
 * Builds the key a connection's password is stored under.
 *
 * Keyed by what actually authenticates -- account, address and port -- rather
 * than by the ssh_config alias, so renaming a host does not strand its
 * password, and two aliases for the same account share one entry.
 *
 * @param connection The connection.
 * @returns The storage key.
 */
export function secretKey(connection: SSHConnection): string {
    const port = connection.port ?? SSH_DEFAULT_PORT;
    return `password:${connection.user ?? ''}@${connection.hostname}:${port}`;
}

/** Reads and writes saved passwords. */
export class CredentialStore {
    /**
     * @param secrets The extension's secret storage.
     */
    constructor(private readonly secrets: vscode.SecretStorage) {}

    /**
     * Reads a saved password.
     *
     * @param connection The connection.
     * @returns The password, or undefined when none is saved.
     */
    async read(connection: SSHConnection): Promise<string | undefined> {
        return this.secrets.get(secretKey(connection));
    }

    /**
     * Saves a password, if the user has asked for passwords to be saved.
     *
     * @param connection The connection.
     * @param password The password to keep.
     */
    async save(connection: SSHConnection, password: string): Promise<void> {
        if (savePasswords()) {
            await this.secrets.store(secretKey(connection), password);
        }
    }

    /**
     * Removes a saved password.
     *
     * @param connection The connection.
     */
    async forget(connection: SSHConnection): Promise<void> {
        await this.secrets.delete(secretKey(connection));
    }
}

/**
 * Whether passwords should be kept in the OS keychain.
 *
 * @returns The user's current preference.
 */
export function savePasswords(): boolean {
    return vscode.workspace.getConfiguration('sshMultiConnect').get<boolean>('savePasswords', false);
}
