import * as vscode from 'vscode';
import * as net from 'net';
import { Client } from 'ssh2';
import { TunnelConfig, TunnelState, conflictsWith, tunnelLabel } from './utils/tunnelModel';

/**
 * Turns a listen failure into something the user can act on.
 *
 * @param error The error Node reported.
 * @param bindAddress The interface that was asked for.
 * @param listenPort The port that was asked for.
 * @returns An explanatory message.
 */
export function explainListenFailure(error: NodeJS.ErrnoException, bindAddress: string, listenPort: number): string {
    const where = `${bindAddress}:${listenPort}`;

    switch (error.code) {
        case 'EADDRINUSE':
            return `Port ${listenPort} is already in use on ${bindAddress}. Choose another local port, or stop whatever is using it.`;
        case 'EACCES':
            return `Not allowed to listen on ${where}. Ports below 1024 need elevated privileges; pick a port above 1024.`;
        case 'EADDRNOTAVAIL':
            return `${bindAddress} is not an address on this machine.`;
        default:
            return `Could not listen on ${where}: ${error.message}`;
    }
}

/**
 * Explains why the server would not open a remote listener.
 *
 * @param error The error ssh2 reported.
 * @param bindAddress The interface requested on the server.
 * @param listenPort The port requested on the server.
 * @returns An explanatory message.
 */
export function explainForwardInFailure(error: Error, bindAddress: string, listenPort: number): string {
    const base = `The server refused to listen on ${bindAddress}:${listenPort}`;

    if (/administratively prohibited/i.test(error.message)) {
        return `${base}: remote forwarding is disabled. The server needs "AllowTcpForwarding yes", and "GatewayPorts yes" to bind anything other than localhost.`;
    }

    return `${base}: ${error.message}. The port may already be in use on the server, or binding ${bindAddress} may need "GatewayPorts yes".`;
}

/**
 * Explains why traffic through a running tunnel was refused.
 *
 * The listener is ours, so these failures come from the far side and the
 * wording has to point there rather than at the local port.
 *
 * @param message What ssh2 reported.
 * @param config The tunnel that failed to carry the connection.
 * @returns An explanatory message.
 */
export function explainForwardFailure(message: string, config: TunnelConfig): string {
    const destination = `${config.destinationHost}:${config.destinationPort}`;

    if (/administratively prohibited/i.test(message)) {
        return `${message} — the server has TCP forwarding disabled (AllowTcpForwarding).`;
    }

    if (/connection refused/i.test(message)) {
        return `Nothing is listening on ${destination} at the far end of the tunnel. The port opened here is fine; the service it points at is not running or is on a different port.`;
    }

    if (/host is unreachable|no route to host|could not resolve|name or service not known/i.test(message)) {
        return `${destination} could not be reached from the far end of the tunnel: ${message}`;
    }

    return message;
}

/** Prefixed so tunnel activity is easy to pick out of the extension host log. */
function log(message: string): void {
    console.log(`[ssh-multi-connect] tunnel: ${message}`);
}

/** A configured tunnel plus its current runtime state. */
export interface TunnelEntry {
    config: TunnelConfig;
    state: TunnelState;
    /** Why the tunnel stopped, when the state is `error`. */
    error?: string;
    /**
     * Why the last connection through an otherwise-running tunnel failed.
     *
     * A listener can open perfectly while every connection through it is
     * refused -- `AllowTcpForwarding no` on the server is the usual cause --
     * so this is tracked separately from the tunnel's own state.
     */
    lastError?: string;
    /** Connections carried since the tunnel last started. */
    connectionCount: number;
}

/** Everything a running tunnel has to tear down when it stops. */
interface Runtime {
    server?: net.Server;
    /** Removes the client listener a remote forward installs. */
    detach?: () => void;
    sockets: Set<net.Socket>;
    /** Set once a failure has been reported, so each one is shown only once. */
    reportedFailure?: boolean;
    /** Set once traffic has been seen, so a busy tunnel does not flood the log. */
    loggedFirstConnection?: boolean;
}

/**
 * Runs and tracks the port forwards belonging to each SSH connection.
 *
 * Tunnels live only as long as the connection: the list is held in memory and
 * dropped when the connection closes, so nothing is written to ssh_config and
 * nothing survives a restart.
 */
export class TunnelManager {
    private readonly entries = new Map<string, TunnelEntry[]>();
    private readonly runtimes = new Map<string, Runtime>();
    private readonly changeEmitter = new vscode.EventEmitter<string>();

    /** Fires with the connection id whose tunnels changed. */
    readonly onDidChange: vscode.Event<string> = this.changeEmitter.event;

    /**
     * @param getClient Supplies the live SSH client for a connection.
     */
    constructor(private readonly getClient: (connectionId: string) => Client | undefined) {}

    /**
     * Lists a connection's tunnels.
     *
     * @param connectionId The connection.
     * @returns Its tunnels, in creation order.
     */
    list(connectionId: string): TunnelEntry[] {
        return this.entries.get(connectionId) ?? [];
    }

    /**
     * Registers a tunnel and starts it.
     *
     * @param connectionId The connection to attach it to.
     * @param config The tunnel to add.
     * @returns The new entry, or undefined when it clashes with an existing one.
     */
    async add(connectionId: string, config: TunnelConfig): Promise<TunnelEntry | undefined> {
        const existing = this.list(connectionId);
        if (existing.some(entry => conflictsWith(entry.config, config))) {
            return undefined;
        }

        const entry: TunnelEntry = { config, state: 'stopped', connectionCount: 0 };
        this.entries.set(connectionId, [...existing, entry]);
        await this.start(connectionId, config.id);
        return entry;
    }

    /**
     * Stops a tunnel and forgets it.
     *
     * @param connectionId The connection it belongs to.
     * @param tunnelId The tunnel to remove.
     */
    async remove(connectionId: string, tunnelId: string): Promise<void> {
        await this.stop(connectionId, tunnelId);
        this.entries.set(
            connectionId,
            this.list(connectionId).filter(entry => entry.config.id !== tunnelId)
        );
        this.changeEmitter.fire(connectionId);
    }

    /**
     * Starts a stopped tunnel.
     *
     * @param connectionId The connection it belongs to.
     * @param tunnelId The tunnel to start.
     */
    async start(connectionId: string, tunnelId: string): Promise<void> {
        const entry = this.find(connectionId, tunnelId);
        if (!entry || entry.state === 'active' || entry.state === 'starting') {
            return;
        }

        const client = this.getClient(connectionId);
        if (!client) {
            this.settle(connectionId, entry, 'error', 'The SSH connection is not established.');
            return;
        }

        this.settle(connectionId, entry, 'starting');
        entry.connectionCount = 0;

        // Tunnel lifecycle events are rare and are the first thing needed
        // when a forward misbehaves, so they are logged.
        log(`starting ${entry.config.kind} ${tunnelLabel(entry.config)} on ${connectionId}`);

        try {
            const runtime =
                entry.config.kind === 'local'
                    ? await this.startLocal(client, entry, connectionId)
                    : await this.startRemote(client, entry, connectionId);

            this.runtimes.set(this.key(connectionId, tunnelId), runtime);
            this.settle(connectionId, entry, 'active');
            log(`listening: ${tunnelLabel(entry.config)}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log(`failed to start ${tunnelLabel(entry.config)}: ${message}`);
            this.settle(connectionId, entry, 'error', message);
        }
    }

    /**
     * Stops a running tunnel, leaving it in the list.
     *
     * @param connectionId The connection it belongs to.
     * @param tunnelId The tunnel to stop.
     */
    async stop(connectionId: string, tunnelId: string): Promise<void> {
        const key = this.key(connectionId, tunnelId);
        const runtime = this.runtimes.get(key);
        this.runtimes.delete(key);

        if (runtime) {
            runtime.detach?.();
            for (const socket of runtime.sockets) {
                socket.destroy();
            }
            runtime.sockets.clear();
            await new Promise<void>(resolve => (runtime.server ? runtime.server.close(() => resolve()) : resolve()));
        }

        const entry = this.find(connectionId, tunnelId);
        if (entry) {
            this.settle(connectionId, entry, 'stopped');
        }
    }

    /**
     * Tears down every tunnel on a connection and forgets them.
     *
     * Called when the connection closes: a tunnel cannot outlive the SSH
     * session that carries it.
     *
     * @param connectionId The connection that went away.
     */
    async disposeConnection(connectionId: string): Promise<void> {
        for (const entry of this.list(connectionId)) {
            await this.stop(connectionId, entry.config.id);
        }
        this.entries.delete(connectionId);
        this.changeEmitter.fire(connectionId);
    }

    dispose(): void {
        for (const connectionId of [...this.entries.keys()]) {
            void this.disposeConnection(connectionId);
        }
        this.changeEmitter.dispose();
    }

    /**
     * Records why a connection through a running tunnel failed.
     *
     * Reported once per start: a broken tunnel would otherwise raise a
     * notification for every connection attempt.
     *
     * @param connectionId The connection the tunnel belongs to.
     * @param entry The tunnel that failed to carry traffic.
     * @param message What went wrong.
     */
    /** Notes the first connection carried since a tunnel started. */
    private logFirstConnection(connectionId: string, entry: TunnelEntry): void {
        const runtime = this.runtimes.get(this.key(connectionId, entry.config.id));
        if (runtime && !runtime.loggedFirstConnection) {
            runtime.loggedFirstConnection = true;
            log(`first connection through ${tunnelLabel(entry.config)}`);
        }
    }

    private noteFailure(connectionId: string, entry: TunnelEntry, message: string): void {
        log(`forward failed on ${tunnelLabel(entry.config)}: ${message}`);
        entry.lastError = explainForwardFailure(message, entry.config);

        const runtime = this.runtimes.get(this.key(connectionId, entry.config.id));
        if (runtime && !runtime.reportedFailure) {
            runtime.reportedFailure = true;
            vscode.window.showWarningMessage(
                `Tunnel ${tunnelLabel(entry.config)} could not forward a connection: ${message}`
            );
        }

        this.changeEmitter.fire(connectionId);
    }

    /** Opens a local listener that forwards out through the SSH connection. */
    private startLocal(client: Client, entry: TunnelEntry, connectionId: string): Promise<Runtime> {
        const { bindAddress, listenPort, destinationHost, destinationPort } = entry.config;
        const sockets = new Set<net.Socket>();

        return new Promise((resolve, reject) => {
            const server = net.createServer(socket => {
                sockets.add(socket);
                socket.on('close', () => sockets.delete(socket));

                // Only the first is logged: it is the signal that something
                // actually reached the port, and logging every connection
                // would flood a busy tunnel.
                this.logFirstConnection(connectionId, entry);
                client.forwardOut(
                    socket.remoteAddress ?? '127.0.0.1',
                    socket.remotePort ?? 0,
                    destinationHost,
                    destinationPort,
                    (err, stream) => {
                        if (err) {
                            // Silently dropping this made a listening tunnel
                            // look healthy while every connection died.
                            this.noteFailure(connectionId, entry, err.message);
                            socket.destroy();
                            return;
                        }

                        entry.connectionCount++;
                        entry.lastError = undefined;
                        socket.pipe(stream).pipe(socket);
                        stream.on('error', (streamError: Error) => {
                            this.noteFailure(connectionId, entry, streamError.message);
                            socket.destroy();
                        });
                    }
                );
            });

            server.on('error', error => {
                // The half-open server would otherwise linger as a handle.
                server.close();
                reject(new Error(explainListenFailure(error, bindAddress, listenPort)));
            });
            server.listen(listenPort, bindAddress, () => resolve({ server, sockets }));
        });
    }

    /** Asks the server to listen, and connects each request back locally. */
    private startRemote(client: Client, entry: TunnelEntry, connectionId: string): Promise<Runtime> {
        const { bindAddress, listenPort, destinationHost, destinationPort } = entry.config;
        const sockets = new Set<net.Socket>();

        return new Promise((resolve, reject) => {
            const onTcpConnection = (
                info: { destPort: number },
                accept: () => NodeJS.ReadWriteStream,
                deny: () => void
            ) => {
                // One listener per tunnel, so each ignores the others' ports.
                if (info.destPort !== listenPort) {
                    return;
                }

                // The local side is connected first: accept() and deny() are
                // alternatives, so accepting up front left no way to refuse a
                // channel whose local connection then failed.
                const socket = net.connect(destinationPort, destinationHost);
                sockets.add(socket);

                socket.once('connect', () => {
                    const stream = accept();
                    entry.connectionCount++;
                    entry.lastError = undefined;
                    socket.pipe(stream).pipe(socket);
                    stream.on('error', (streamError: Error) =>
                        this.noteFailure(connectionId, entry, streamError.message)
                    );
                });

                socket.once('error', (socketError: Error) => {
                    sockets.delete(socket);
                    this.noteFailure(connectionId, entry, socketError.message);
                    deny();
                });

                socket.on('close', () => sockets.delete(socket));
            };

            client.forwardIn(bindAddress, listenPort, error => {
                if (error) {
                    reject(new Error(explainForwardInFailure(error, bindAddress, listenPort)));
                    return;
                }

                client.on('tcp connection', onTcpConnection);
                resolve({
                    sockets,
                    detach: () => {
                        client.removeListener('tcp connection', onTcpConnection);
                        client.unforwardIn(bindAddress, listenPort, () => undefined);
                    },
                });
            });
        });
    }

    private find(connectionId: string, tunnelId: string): TunnelEntry | undefined {
        return this.list(connectionId).find(entry => entry.config.id === tunnelId);
    }

    private key(connectionId: string, tunnelId: string): string {
        return `${connectionId}::${tunnelId}`;
    }

    private settle(connectionId: string, entry: TunnelEntry, state: TunnelState, error?: string): void {
        entry.state = state;
        entry.error = error;
        if (state === 'starting') {
            entry.lastError = undefined;
        }
        this.changeEmitter.fire(connectionId);
    }
}
