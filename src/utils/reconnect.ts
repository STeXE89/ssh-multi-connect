/**
 * Deciding when and how to rebuild a connection that dropped.
 *
 * A suspended machine is the usual cause: the link is gone, but nothing
 * notices until something tries to write, so the host sits there looking
 * connected. Keeping the rules here, free of `vscode` and `ssh2`, keeps the
 * timing and the "can this be done without asking again" decision testable.
 */

import { SSHConnection } from './sshConfig';

/** The credentials a connection is holding, if any. */
export interface CachedCredentials {
    password?: string;
    privateKey?: unknown;
    passphrase?: string;
    identityFile?: string;
}

/**
 * Builds the waits between reconnection attempts.
 *
 * The first is short, because a link that came back with the machine is
 * usually ready at once; later ones back off so a server that is genuinely
 * down is not hammered. Each delay doubles up to a ceiling.
 *
 * @param attempts How many attempts to make.
 * @param firstDelay The wait before the first retry, in milliseconds.
 * @param maxDelay The longest wait, in milliseconds.
 * @returns One delay per attempt, in order.
 */
export function backoffDelays(attempts: number, firstDelay = 2000, maxDelay = 30000): number[] {
    const delays: number[] = [];

    for (let attempt = 0; attempt < Math.max(0, attempts); attempt++) {
        delays.push(Math.min(firstDelay * 2 ** attempt, maxDelay));
    }

    return delays;
}

/**
 * Reports whether a connection can be rebuilt without asking for anything.
 *
 * A password typed earlier, or a key already read and decrypted, is enough. A
 * connection with neither would put a prompt on screen for a machine the user
 * may have walked away from, so it is left alone.
 *
 * @param connection The connection that dropped.
 * @returns True when a silent reconnection is possible.
 */
export function canReconnectSilently(connection: SSHConnection & CachedCredentials): boolean {
    if (connection.password) {
        return true;
    }

    // A key needs no prompt unless it is encrypted and the passphrase was
    // never given; both are held together, so either alone is not enough.
    return !!connection.identityFile && (!!connection.privateKey || !!connection.passphrase);
}

/**
 * Describes an attempt, for the tree and the log.
 *
 * @param host The host being rebuilt.
 * @param attempt The attempt about to be made, counting from zero.
 * @param total How many will be made.
 * @returns A short sentence.
 */
export function describeAttempt(host: string, attempt: number, total: number): string {
    return `Reconnecting to ${host} (${attempt + 1} of ${total})`;
}

/**
 * The keepalive to apply when the host's config asks for none.
 *
 * Without any probe a dropped link is only noticed when something writes to
 * it, which is why a suspended machine wakes up with connections that look
 * live and are not. The count is fixed at three: the interval is the knob
 * worth exposing.
 *
 * @param seconds The interval from settings, where zero disables it.
 * @returns The ssh2 keepalive options, or nothing when disabled.
 */
export function defaultKeepalive(
    seconds: number
): { keepaliveInterval: number; keepaliveCountMax: number } | undefined {
    return seconds > 0 ? { keepaliveInterval: seconds * 1000, keepaliveCountMax: 3 } : undefined;
}
