/**
 * Pure parsing of the ssh_config directives that put a bastion in front of a
 * host: `ProxyJump`, and the `ProxyCommand` forms that mean the same thing.
 *
 * No sockets and no `vscode`, so the awkward part -- reading what the user
 * wrote -- can be tested on its own.
 */

import { SSH_DEFAULT_PORT } from './sshConfig';

/** One bastion in a jump chain. */
export interface JumpHop {
    /** The ssh_config alias or address to connect to. */
    host: string;
    /** Only set when the spec named one; otherwise the host's own config wins. */
    user?: string;
    port?: number;
}

/**
 * Parses a `ProxyJump` value into its hops, in the order they are traversed.
 *
 * `none` disables jumping, and is reported as an empty list rather than as a
 * parse failure: the directive was understood, it just asks for nothing.
 *
 * @param value The directive's value.
 * @returns The hops, or undefined when the value cannot be read.
 */
export function parseProxyJump(value: string): JumpHop[] | undefined {
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === 'none') {
        return [];
    }

    const hops: JumpHop[] = [];
    for (const piece of trimmed.split(',')) {
        const hop = parseHop(piece.trim());
        if (!hop) {
            return undefined;
        }
        hops.push(hop);
    }

    return hops;
}

/**
 * Parses one `[user@]host[:port]` hop.
 *
 * @param spec The hop text.
 * @returns The hop, or undefined when it is malformed.
 */
function parseHop(spec: string): JumpHop | undefined {
    if (!spec) {
        return undefined;
    }

    const at = spec.lastIndexOf('@');
    const user = at === -1 ? undefined : spec.slice(0, at);
    const rest = at === -1 ? spec : spec.slice(at + 1);
    if (at !== -1 && !user) {
        return undefined;
    }

    // A bracketed IPv6 literal may carry a port after the closing bracket;
    // a bare one is all colons and has none.
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
    const [host, portText] = bracketed ? [bracketed[1], bracketed[2]] : splitOnLastColon(rest);

    if (!host) {
        return undefined;
    }

    let port: number | undefined;
    if (portText !== undefined) {
        port = Number(portText);
        if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) {
            return undefined;
        }
    }

    return { host, ...(user === undefined ? {} : { user }), ...(port === undefined ? {} : { port }) };
}

/**
 * Splits `host:port`, leaving a bare IPv6 address whole.
 *
 * @param rest The host part of a hop.
 * @returns The host and, when present, the port text.
 */
function splitOnLastColon(rest: string): [string, string | undefined] {
    const colons = rest.split(':').length - 1;
    if (colons !== 1) {
        return [rest, undefined];
    }
    const index = rest.indexOf(':');
    return [rest.slice(0, index), rest.slice(index + 1)];
}

/**
 * Recognises the `ProxyCommand` forms that are just a jump written the long
 * way, so a config written before `ProxyJump` existed still works.
 *
 * Both the modern `ssh -W %h:%p bastion` and the older `ssh bastion nc %h %p`
 * are matched. Anything else -- a corkscrew proxy, a cloud CLI shim, a shell
 * pipeline -- is not a jump and is left alone rather than guessed at.
 *
 * @param command The directive's value.
 * @returns An equivalent `ProxyJump` value, or undefined.
 */
export function proxyJumpFromCommand(command: string): string | undefined {
    const words = command.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0 || !/(^|[/\\])ssh(\.exe)?$/i.test(words[0])) {
        return undefined;
    }

    const tail = words.slice(1);
    const netcat = tail.findIndex(word => /(^|[/\\])(nc|netcat|ncat)(\.exe)?$/i.test(word));
    const target = netcat === -1 ? jumpTargetFromW(tail) : jumpTargetBefore(tail.slice(0, netcat));

    return target;
}

/** Finds the bastion in an `ssh ... -W %h:%p ... bastion` command. */
function jumpTargetFromW(tail: string[]): string | undefined {
    const w = tail.findIndex(word => word === '-W');
    if (w === -1 || !/^%h:%p$/i.test(tail[w + 1] ?? '')) {
        return undefined;
    }
    return jumpTargetBefore([...tail.slice(0, w), ...tail.slice(w + 2)]);
}

/**
 * Picks the bastion out of the remaining `ssh` arguments.
 *
 * Only the flags that take a value and could be confused for a host name are
 * skipped; an unrecognised flag means the command is doing something this
 * cannot model, so nothing is returned.
 */
function jumpTargetBefore(words: string[]): string | undefined {
    /** `ssh` flags that consume the next argument. */
    const WITH_VALUE = new Set(['-p', '-i', '-o', '-l', '-F', '-b', '-c', '-m', '-J', '-w', '-e']);
    /** Flags that are safe to ignore; `-W` and friends are handled above. */
    const STANDALONE = /^-[1246AaCfGgKkMNnqsTtVvXxYy]+$/;

    let user: string | undefined;
    let port: string | undefined;
    let host: string | undefined;

    for (let index = 0; index < words.length; index++) {
        const word = words[index];
        if (WITH_VALUE.has(word)) {
            const value = words[++index];
            if (value === undefined) {
                return undefined;
            }
            if (word === '-l') {
                user = value;
            } else if (word === '-p') {
                port = value;
            }
            continue;
        }
        if (word.startsWith('-')) {
            if (!STANDALONE.test(word)) {
                return undefined;
            }
            continue;
        }
        if (host !== undefined) {
            // A second bare word is a remote command, not a host.
            return undefined;
        }
        host = word;
    }

    if (!host || host.includes('%')) {
        return undefined;
    }

    const withUser = user && !host.includes('@') ? `${user}@${host}` : host;
    return port && !/:\d+$/.test(withUser) ? `${withUser}:${port}` : withUser;
}

/**
 * Resolves the port a hop connects on.
 *
 * @param hop The hop.
 * @param configured The port its ssh_config entry gives, if any.
 * @returns The port to dial.
 */
export function hopPort(hop: JumpHop, configured?: number): number {
    return hop.port ?? configured ?? SSH_DEFAULT_PORT;
}
