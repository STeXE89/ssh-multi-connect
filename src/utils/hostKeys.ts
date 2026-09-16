/**
 * Host key formatting, for connections that `ssh-keyscan` cannot reach.
 *
 * A host behind a bastion is only reachable through the tunnel, so its key has
 * to be checked from the handshake itself rather than scanned beforehand.
 * These helpers turn the raw key ssh2 hands to a `hostVerifier` into the two
 * forms the rest of the extension already speaks: an OpenSSH fingerprint, and
 * a known_hosts line.
 */

import { createHash } from 'crypto';
import { SSH_DEFAULT_PORT } from './sshConfig';

/**
 * Computes the SHA256 fingerprint of a raw host key, in OpenSSH's format.
 *
 * The same text `ssh-keygen -l` prints: base64 with the padding stripped.
 *
 * @param key The key blob from the handshake.
 * @returns A fingerprint such as `SHA256:abc...`.
 */
export function fingerprintOfKey(key: Buffer): string {
    return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Reads the algorithm name out of a key blob.
 *
 * An SSH wire-format key starts with its own algorithm name, as a
 * length-prefixed string.
 *
 * @param key The key blob from the handshake.
 * @returns The algorithm, such as `ssh-ed25519`, or undefined when the blob is
 * too short or does not start with one.
 */
export function keyAlgorithm(key: Buffer): string | undefined {
    if (key.length < 4) {
        return undefined;
    }

    const length = key.readUInt32BE(0);
    if (length === 0 || length > 64 || key.length < 4 + length) {
        return undefined;
    }

    const name = key.subarray(4, 4 + length).toString('ascii');
    return /^[\x21-\x7e]+$/.test(name) ? name : undefined;
}

/**
 * Builds the known_hosts line for a host key.
 *
 * A non-default port is written in OpenSSH's `[host]:port` form, which is how
 * `ssh` itself records one.
 *
 * @param hostname The address the key belongs to.
 * @param port The port it was served on.
 * @param key The key blob from the handshake.
 * @returns The line, without a trailing newline, or undefined when the blob is
 * not a key.
 */
export function knownHostsLine(hostname: string, port: number, key: Buffer): string | undefined {
    const algorithm = keyAlgorithm(key);
    if (!algorithm) {
        return undefined;
    }

    const host = port === SSH_DEFAULT_PORT ? hostname : `[${hostname}]:${port}`;
    return `${host} ${algorithm} ${key.toString('base64')}`;
}
