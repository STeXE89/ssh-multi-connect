/**
 * The user-facing half of `ProxyJump` support: working out which bastions a
 * host sits behind, asking for their credentials, and checking their host
 * keys.
 *
 * The chain itself is built in `proxyChain.ts`, which knows nothing about
 * `vscode`; everything that prompts or touches known_hosts lives here.
 */

import * as vscode from 'vscode';
import { utils } from 'ssh2';
import { AuthProvider, HopPosition, HopTarget, KeyApprover, HostResolver } from './proxyChain';
import { JumpHop, parseProxyJump, proxyJumpFromCommand } from './utils/proxyJump';
import { SSHConnection } from './utils/sshConfig';
import { fingerprintOfKey } from './utils/hostKeys';
import { getConnection, isKnownHost, removeKnownHost, rememberHostKey, resolveIdentityFile } from './utils/sshUtils';
import { readFile } from './utils/fileUtils';
import { accountLabel, hopPasswordPrompt, hopPassphrasePrompt } from './utils/authPrompts';

/** What a host's config asks for in front of it. */
export type JumpPlan =
    | { kind: 'direct' }
    | { kind: 'jump'; hops: JumpHop[] }
    /** A `ProxyCommand` that is not a plain jump, which is not run. */
    | { kind: 'unsupported'; command: string };

/**
 * Works out what stands between this machine and a host.
 *
 * `ProxyJump` wins over `ProxyCommand`, as it does in `ssh`. A `ProxyCommand`
 * is only honoured when it is a jump written the long way: running an
 * arbitrary command from a config file is left to `ssh` itself.
 *
 * @param connection The host being connected to.
 * @returns How to reach it.
 */
export function jumpPlanFor(connection: SSHConnection): JumpPlan {
    if (connection.proxyJump) {
        const hops = parseProxyJump(connection.proxyJump);
        if (!hops) {
            return { kind: 'unsupported', command: `ProxyJump ${connection.proxyJump}` };
        }
        return hops.length === 0 ? { kind: 'direct' } : { kind: 'jump', hops };
    }

    if (connection.proxyCommand) {
        const equivalent = proxyJumpFromCommand(connection.proxyCommand);
        const hops = equivalent ? parseProxyJump(equivalent) : undefined;
        return hops && hops.length > 0
            ? { kind: 'jump', hops }
            : { kind: 'unsupported', command: `ProxyCommand ${connection.proxyCommand}` };
    }

    return { kind: 'direct' };
}

/** Reads a hop's ssh_config entry. */
export const resolveHost: HostResolver = alias => getConnection(alias);

/**
 * Builds the credential prompt for jump hosts.
 *
 * A hop with an `IdentityFile` uses it, asking for a passphrase only when the
 * key turns out to be encrypted; anything else is asked for a password. What
 * the user types is kept for the life of the chain so a repeated hop is only
 * asked about once.
 *
 * @param destination The host the chain is on the way to, named in the prompts
 * so it is clear that a bastion, not the destination, is asking.
 * @returns An auth provider for `openJumpChain`.
 */
export function createAuthProvider(destination: string): AuthProvider {
    const answered = new Map<string, { privateKey?: Buffer; passphrase?: string; password?: string }>();

    return async (hop: JumpHop, target: HopTarget, position: HopPosition) => {
        const account = accountLabel(target.username, target.host, target.port);
        const cached = answered.get(account);
        if (cached) {
            return cached;
        }

        const configured = getConnection(hop.host);
        const credentials = configured?.identityFile
            ? await keyCredentials(configured.identityFile, account, position, destination)
            : await passwordCredentials(account, position, destination);

        answered.set(account, credentials);
        return credentials;
    };
}

/** Loads a hop's private key, asking for a passphrase when it is encrypted. */
async function keyCredentials(identityFile: string, label: string, position: HopPosition, destination: string) {
    let privateKey: Buffer;
    try {
        privateKey = Buffer.from(readFile(resolveIdentityFile(identityFile)));
    } catch (error) {
        throw new Error(`Jump host ${label}: cannot read "${identityFile}": ${(error as Error).message}`);
    }

    const parsed = utils.parseKey(privateKey);
    if (!(parsed instanceof Error)) {
        return { privateKey };
    }

    if (!/encrypted|passphrase/i.test(parsed.message)) {
        throw new Error(`Jump host ${label}: invalid private key "${identityFile}": ${parsed.message}`);
    }

    const passphrase = await vscode.window.showInputBox({
        ...hopPassphrasePrompt(label, identityFile, position.index, position.total, destination),
        password: true,
        ignoreFocusOut: true,
    });

    if (!passphrase) {
        throw new Error(`Jump host ${label}: no passphrase provided.`);
    }

    return { privateKey, passphrase };
}

/** Asks for a hop's password. */
async function passwordCredentials(label: string, position: HopPosition, destination: string) {
    const password = await vscode.window.showInputBox({
        ...hopPasswordPrompt(label, position.index, position.total, destination),
        password: true,
        ignoreFocusOut: true,
    });

    if (!password) {
        throw new Error(`Jump host ${label}: no password provided.`);
    }

    return { password };
}

/**
 * Builds the host key check used for every host reached through a chain.
 *
 * These hosts cannot be scanned beforehand -- only the tunnel reaches them --
 * so the key is checked as it arrives. An unknown host is recorded, and a
 * changed key stops the connection unless the user says otherwise, which is
 * the same bargain the direct path makes.
 *
 * @returns A key approver for `openJumpChain`.
 */
export function createKeyApprover(): KeyApprover {
    return async (target: HopTarget, key: Buffer) => {
        const fingerprint = fingerprintOfKey(key);
        const { exists, key: stored } = isKnownHost(target.host);

        if (exists && stored === fingerprint) {
            return true;
        }

        if (exists && stored) {
            const answer = await vscode.window.showWarningMessage(
                `The host key for ${target.host} has changed. Someone could be intercepting the connection. Accept the new key?`,
                { modal: true },
                'Accept'
            );

            if (answer !== 'Accept') {
                return false;
            }

            removeKnownHost(target.host);
        }

        if (!rememberHostKey(target.host, target.port, key)) {
            return false;
        }

        if (!exists) {
            vscode.window.showInformationMessage(`Host "${target.host}" added to known_hosts (${fingerprint}).`);
        }

        return true;
    };
}
