/**
 * Types and pure helpers for SSH port forwarding.
 *
 * Kept free of `net` and `vscode` so the validation and labelling can be
 * tested without opening a socket.
 */

/** Which direction traffic is forwarded. */
export type TunnelKind = 'local' | 'remote';

/** How a tunnel is currently behaving. */
export type TunnelState = 'stopped' | 'starting' | 'active' | 'error';

export interface TunnelConfig {
    id: string;
    kind: TunnelKind;
    /** Interface the listening side binds to. */
    bindAddress: string;
    /** Port that accepts connections. */
    listenPort: number;
    /** Host traffic is delivered to, resolved on the far side. */
    destinationHost: string;
    destinationPort: number;
}

export const LOOPBACK = '127.0.0.1';
export const ALL_INTERFACES = '0.0.0.0';
const MAX_PORT = 65535;

/**
 * Parses and validates a port number.
 *
 * @param value The text entered by the user.
 * @param allowZero Whether 0 ("pick any free port") is acceptable.
 * @returns The port, or undefined when the text is not a valid port.
 */
export function parsePort(value: string, allowZero = false): number | undefined {
    if (!/^\d{1,5}$/.test(value.trim())) {
        return undefined;
    }

    const port = Number(value.trim());
    const lowest = allowZero ? 0 : 1;
    return port >= lowest && port <= MAX_PORT ? port : undefined;
}

/**
 * Validates a port for an input box.
 *
 * @param value The text entered by the user.
 * @param allowZero Whether 0 is acceptable.
 * @returns An error message, or undefined when the value is fine.
 */
export function validatePort(value: string, allowZero = false): string | undefined {
    return parsePort(value, allowZero) === undefined
        ? `Enter a port between ${allowZero ? 0 : 1} and ${MAX_PORT}.`
        : undefined;
}

/**
 * Validates a host name or address for an input box.
 *
 * @param value The text entered by the user.
 * @returns An error message, or undefined when the value is fine.
 */
export function validateHost(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) {
        return 'A host is required.';
    }
    if (!/^[A-Za-z0-9._:[\]-]+$/.test(trimmed)) {
        return 'That is not a valid host name or address.';
    }
    // A wildcard address means "every interface" when binding; as a
    // destination there is nothing for it to mean.
    if (trimmed === ALL_INTERFACES || trimmed === '::' || trimmed === '[::]') {
        return 'A destination cannot be a wildcard address. Use localhost for the machine itself.';
    }
    return undefined;
}

/**
 * Builds the arrow label shown in the tree.
 *
 * The listening side is always on the left, so the label reads in the
 * direction traffic actually travels.
 *
 * @param config The tunnel.
 * @returns A label such as `127.0.0.1:8080 -> db:5432`.
 */
export function tunnelLabel(config: TunnelConfig): string {
    const listen = `${config.bindAddress}:${config.listenPort}`;
    const destination = `${config.destinationHost}:${config.destinationPort}`;
    return `${listen} -> ${destination}`;
}

/**
 * Describes what a tunnel does, for a tooltip.
 *
 * @param config The tunnel.
 * @param hostLabel The SSH host the tunnel runs over.
 * @returns A human-readable sentence.
 */
export function describeTunnel(config: TunnelConfig, hostLabel: string): string {
    return config.kind === 'local'
        ? `Local forward: connections to ${config.bindAddress}:${config.listenPort} on this machine ` +
              `reach ${config.destinationHost}:${config.destinationPort} as seen from ${hostLabel}.`
        : `Remote forward: connections to ${config.bindAddress}:${config.listenPort} on ${hostLabel} ` +
              `reach ${config.destinationHost}:${config.destinationPort} from this machine.`;
}

/**
 * The equivalent OpenSSH flag, shown so the tunnel is recognisable.
 *
 * @param config The tunnel.
 * @returns An `ssh` command fragment.
 */
export function tunnelFlag(config: TunnelConfig): string {
    const spec = `${config.bindAddress}:${config.listenPort}:${config.destinationHost}:${config.destinationPort}`;
    return `${config.kind === 'local' ? '-L' : '-R'} ${spec}`;
}

/**
 * Reports whether two tunnels would listen on the same address and port.
 *
 * @param a One tunnel.
 * @param b Another tunnel.
 * @returns True when they collide.
 */
export function conflictsWith(a: TunnelConfig, b: TunnelConfig): boolean {
    return a.kind === b.kind && a.listenPort === b.listenPort && a.bindAddress === b.bindAddress;
}

/**
 * Parses one `LocalForward`/`RemoteForward` value from ssh_config.
 *
 * OpenSSH accepts `[bind_address:]port host:hostport`, and also tolerates the
 * colon-joined `-L` form (`[bind:]port:host:hostport`), so both are read here.
 * IPv6 literals are written in brackets, which are stripped from the result:
 * the rest of the extension stores bare addresses.
 *
 * A `RemoteForward` with no destination asks for dynamic (SOCKS) forwarding,
 * which this extension does not implement, so it is rejected rather than
 * guessed at.
 *
 * @param spec The directive's value.
 * @param kind Which directive it came from.
 * @returns The tunnel, without an id, or undefined when the spec is unusable.
 */
export function parseForwardSpec(spec: string, kind: TunnelKind): Omit<TunnelConfig, 'id'> | undefined {
    const words = spec.trim().split(/\s+/).filter(Boolean);
    const parts =
        words.length === 1 ? splitHostPort(words[0]) : [...splitHostPort(words[0]), ...splitHostPort(words[1])];

    // Either [bind, port, host, hostport] or [port, host, hostport].
    if (words.length > 2 || parts.length < 3 || parts.length > 4) {
        return undefined;
    }

    const [bindAddress, listenText, destinationHost, destinationText] =
        parts.length === 4 ? parts : [LOOPBACK, ...parts];

    const listenPort = parsePort(listenText, true);
    const destinationPort = parsePort(destinationText);
    if (listenPort === undefined || destinationPort === undefined) {
        return undefined;
    }
    if (!bindAddress || validateHost(destinationHost) !== undefined) {
        return undefined;
    }

    return { kind, bindAddress, listenPort, destinationHost, destinationPort };
}

/**
 * Splits a token on colons, keeping a bracketed IPv6 literal whole.
 *
 * @param token One whitespace-delimited piece of a forward spec.
 * @returns Its colon-separated fields, with IPv6 brackets removed.
 */
function splitHostPort(token: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inBrackets = false;

    for (const char of token) {
        if (char === '[') {
            inBrackets = true;
        } else if (char === ']') {
            inBrackets = false;
        } else if (char === ':' && !inBrackets) {
            fields.push(current);
            current = '';
        } else {
            current += char;
        }
    }

    fields.push(current);
    return fields;
}

/**
 * Renders a tunnel as an ssh_config directive value.
 *
 * The inverse of `parseForwardSpec`, in the whitespace form `ssh_config`
 * documents. An IPv6 literal is bracketed so the port stays readable.
 *
 * @param config The tunnel.
 * @returns The value for a `LocalForward` or `RemoteForward` line.
 */
export function forwardSpec(config: TunnelConfig): string {
    return `${bracket(config.bindAddress)}:${config.listenPort} ${bracket(config.destinationHost)}:${config.destinationPort}`;
}

/**
 * Names the directive a tunnel is written under.
 *
 * @param config The tunnel.
 * @returns `LocalForward` or `RemoteForward`.
 */
export function forwardDirective(config: TunnelConfig): 'LocalForward' | 'RemoteForward' {
    return config.kind === 'local' ? 'LocalForward' : 'RemoteForward';
}

/**
 * Brackets a bare IPv6 literal, which otherwise runs into its port.
 *
 * @param host The address.
 * @returns The address as it should appear in a forward spec.
 */
function bracket(host: string): string {
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
