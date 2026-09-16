import type { CompressionAlgorithm } from 'ssh2';
import { SSHConnection } from './sshConfig';
import { defaultKeepalive } from './reconnect';

/** Compression preference, most preferred first. */
const COMPRESS_ON: CompressionAlgorithm[] = ['zlib@openssh.com', 'zlib', 'none'];
const COMPRESS_OFF: CompressionAlgorithm[] = ['none'];

/** The subset of ssh2's ConnectConfig this extension derives from ssh_config. */
export interface ConnectionTuning {
    keepaliveInterval?: number;
    keepaliveCountMax?: number;
    agent?: string;
    agentForward?: boolean;
    algorithms?: { compress: CompressionAlgorithm[] };
}

/**
 * Locates the running SSH agent.
 *
 * @param env The environment to read, defaulting to this process's.
 * @param platform The platform, defaulting to this process's.
 * @returns The agent address, or undefined when no agent is reachable.
 */
export function agentAddress(
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform
): string | undefined {
    if (env.SSH_AUTH_SOCK) {
        return env.SSH_AUTH_SOCK;
    }
    // Windows has no SSH_AUTH_SOCK; ssh2 accepts this literal for Pageant,
    // and the OpenSSH agent service is reachable by its named pipe.
    return platform === 'win32' ? 'pageant' : undefined;
}

/**
 * Translates the ssh_config directives this extension parses into ssh2 options.
 *
 * These were read from the config but never applied, so `Compression`,
 * `ForwardAgent` and the `ServerAlive*` pair had no effect at all.
 *
 * @param connection The connection as parsed from ssh_config.
 * @param agent The agent address, or undefined when no agent is reachable.
 *   Passed in rather than defaulted, so a caller can say "no agent" without
 *   the default quietly reintroducing this machine's own.
 * @returns Options to merge into ssh2's connect config.
 */
export function connectionTuning(
    connection: SSHConnection,
    agent: string | undefined,
    keepaliveFallbackSeconds = 0
): ConnectionTuning {
    // The fallback first, so anything the host's own config says replaces it.
    const tuning: ConnectionTuning = { ...defaultKeepalive(keepaliveFallbackSeconds) };

    if (connection.serverAliveInterval !== undefined && connection.serverAliveInterval >= 0) {
        // ssh_config counts seconds; ssh2 wants milliseconds.
        tuning.keepaliveInterval = connection.serverAliveInterval * 1000;
    }

    if (connection.serverAliveCountMax !== undefined && connection.serverAliveCountMax >= 0) {
        tuning.keepaliveCountMax = connection.serverAliveCountMax;
    }

    if (connection.compression !== undefined) {
        tuning.algorithms = { compress: connection.compression ? COMPRESS_ON : COMPRESS_OFF };
    }

    if (connection.forwardAgent && agent) {
        tuning.agent = agent;
        tuning.agentForward = true;
    }

    return tuning;
}

/**
 * Reports whether a failed connection failed because the credentials were
 * wrong, rather than because the host could not be reached.
 *
 * ssh2 tags authentication failures, but a jump host's error arrives already
 * wrapped in a message, so the text is checked too.
 *
 * @param error The error a connection attempt threw.
 * @returns True when the credentials were rejected.
 */
export function isAuthFailure(error: unknown): boolean {
    if ((error as { level?: string })?.level === 'client-authentication') {
        return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /authentication method|permission denied|authentication failed/i.test(message);
}
