/**
 * Opens the SSH chain in front of a host that sits behind one or more
 * bastions, as `ProxyJump` describes it.
 *
 * Each hop is a real SSH connection carried inside the previous one: the first
 * is dialled directly, and every hop after it travels through a
 * `direct-tcpip` channel opened on its predecessor. The channel to the final
 * destination is handed back as a socket, which ssh2 accepts in place of one
 * it would have opened itself.
 *
 * No `vscode` here: the prompting and the known_hosts bookkeeping are supplied
 * by the caller, so a chain can be driven against a local server in a test.
 */

import { Duplex } from 'stream';
import { Client, ConnectConfig } from 'ssh2';
import { JumpHop, hopPort } from './utils/proxyJump';
import { SSHConnection, SSH_DEFAULT_PORT } from './utils/sshConfig';

/** Where a hop is actually dialled, once its config has been applied. */
export interface HopTarget {
    host: string;
    port: number;
    username: string;
}

/** Credentials for one hop. */
export interface HopAuth {
    privateKey?: Buffer;
    passphrase?: string;
    password?: string;
}

/** Supplies credentials for a hop, prompting the user where needed. */
export type AuthProvider = (hop: JumpHop, target: HopTarget) => Promise<HopAuth>;

/** Decides whether a hop's host key is acceptable, and records it. */
export type KeyApprover = (target: HopTarget, key: Buffer) => Promise<boolean>;

/** Looks a hop's alias up in ssh_config. */
export type HostResolver = (alias: string) => SSHConnection | null;

/** A live chain, and the channel that reaches its far end. */
export interface JumpChain {
    /** The channel to the destination, for ssh2's `sock` option. */
    sock: Duplex;
    /** The hops the chain traverses, for a tooltip or log line. */
    description: string;
    /** Closes every hop, innermost first. */
    dispose(): void;
}

/** A host and port to reach at the end of a channel. */
interface Endpoint {
    host: string;
    port: number;
}

/**
 * Builds the chain of bastions and returns a channel to the destination.
 *
 * On any failure every hop opened so far is closed before the error is
 * rethrown, so a half-built chain never leaks a connection.
 *
 * @param hops The bastions, in the order they are traversed.
 * @param destination The host the chain finally reaches.
 * @param resolve Looks a hop's alias up in ssh_config.
 * @param auth Supplies credentials for a hop.
 * @param approve Checks a hop's host key.
 * @returns The open chain.
 */
export async function openJumpChain(
    hops: JumpHop[],
    destination: Endpoint,
    resolve: HostResolver,
    auth: AuthProvider,
    approve: KeyApprover
): Promise<JumpChain> {
    if (hops.length === 0) {
        throw new Error('A jump chain needs at least one host.');
    }

    const clients: Client[] = [];
    const dispose = () => {
        // Innermost first: closing an outer hop would tear the inner ones
        // down underneath themselves.
        for (const client of [...clients].reverse()) {
            client.end();
        }
    };

    try {
        let sock: Duplex | undefined;

        for (const [index, hop] of hops.entries()) {
            const target = resolveHop(hop, resolve);
            const credentials = await auth(hop, target);

            const client = new Client();
            clients.push(client);
            await connectHop(client, target, credentials, approve, sock);

            const next = index + 1 < hops.length ? resolveHop(hops[index + 1], resolve) : destination;
            sock = await openChannel(client, next, describeHop(target));
        }

        return { sock: sock!, description: hops.map(hop => hop.host).join(' -> '), dispose };
    } catch (error) {
        dispose();
        throw error;
    }
}

/**
 * Applies a hop's ssh_config entry to the spec written in `ProxyJump`.
 *
 * What the directive says wins; the host block fills in the rest. The username
 * falls back to the account this process runs as, which is what `ssh` does.
 *
 * @param hop The hop as written.
 * @param resolve Looks the alias up in ssh_config.
 * @returns Where to dial it.
 */
export function resolveHop(hop: JumpHop, resolve: HostResolver): HopTarget {
    const configured = resolve(hop.host);

    return {
        host: configured?.hostname || hop.host,
        port: hopPort(hop, configured?.port),
        username: hop.user ?? configured?.user ?? process.env.USER ?? process.env.USERNAME ?? '',
    };
}

/** Names a hop for an error message. */
function describeHop(target: HopTarget): string {
    return target.port === SSH_DEFAULT_PORT ? target.host : `${target.host}:${target.port}`;
}

/**
 * Connects one hop and waits for its handshake.
 *
 * @param client The client to connect.
 * @param target Where to dial.
 * @param credentials How to authenticate.
 * @param approve Checks the host key.
 * @param sock The channel through the previous hop, if any.
 */
function connectHop(
    client: Client,
    target: HopTarget,
    credentials: HopAuth,
    approve: KeyApprover,
    sock: Duplex | undefined
): Promise<void> {
    return new Promise((resolve, reject) => {
        const settle = (error?: Error) => {
            client.removeListener('ready', onReady);
            client.removeListener('error', onError);
            error ? reject(error) : resolve();
        };

        const onReady = () => settle();
        const onError = (error: Error) => settle(new Error(`Jump host ${describeHop(target)}: ${error.message}`));

        client.once('ready', onReady);
        client.once('error', onError);

        const config: ConnectConfig = {
            host: target.host,
            port: target.port,
            username: target.username,
            ...credentials,
            ...(sock ? { sock } : {}),
            hostVerifier: (key: Buffer, callback: (ok: boolean) => void) => {
                approve(target, key).then(callback, () => callback(false));
            },
        };

        client.connect(config);
    });
}

/**
 * Opens a channel from a hop to the next endpoint.
 *
 * @param client The hop the channel is opened on.
 * @param next Where the channel should arrive.
 * @param via The hop's name, for the error message.
 * @returns The channel, as a stream ssh2 can connect over.
 */
function openChannel(client: Client, next: Endpoint, via: string): Promise<Duplex> {
    return new Promise((resolve, reject) => {
        // The source address is what the far end sees; ssh sends its own
        // loopback and an arbitrary port, and so do we.
        client.forwardOut('127.0.0.1', 0, next.host, next.port, (error, stream) => {
            if (error) {
                reject(new Error(`${via} could not reach ${next.host}:${next.port}: ${error.message}`));
                return;
            }
            resolve(stream);
        });
    });
}
