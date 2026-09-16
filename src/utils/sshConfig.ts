/**
 * Pure parsing and serialization of an OpenSSH client config file.
 *
 * Everything here is string in, string out: no filesystem, no vscode. That
 * keeps the format handling unit-testable, and keeps the destructive parts
 * (writing over the user's real ~/.ssh/config) in one thin layer above.
 *
 * Blocks the extension does not manage are copied through untouched, so a
 * config that also serves the real ssh client keeps its directives, comments
 * and ordering.
 */

export const SSH_DEFAULT_PORT = 22;

export interface SSHConnection {
    host: string;
    hostname: string;
    user?: string;
    port?: number;
    identityFile?: string;
    /** Comma-separated bastion hops, as written by `ssh -J`. */
    proxyJump?: string;
    proxyCommand?: string;
    forwardAgent?: boolean;
    /** ssh_config allows several of these per host, so each is a list. */
    localForward?: string[];
    remoteForward?: string[];
    compression?: boolean;
    serverAliveInterval?: number;
    serverAliveCountMax?: number;
    logLevel?: string;
    vFolderTag?: string;
    /**
     * The file this host was read from, which is not always the main config:
     * an `Include`d host must be written back where it came from. Never
     * serialised.
     */
    sourceFile?: string;
    /**
     * Set when the host's block pulls in another file, so rewriting it from
     * the model would drop the `Include` line. Never serialised.
     */
    readOnly?: boolean;
}

/** A `Host` line plus every line up to the next `Host` line. */
interface HostBlock {
    patterns: string[];
    lines: string[];
}

const HOST_LINE = /^[ \t]*Host(?:[ \t]*=[ \t]*|[ \t]+)(.+?)[ \t]*$/i;
const DIRECTIVE_LINE = /^[ \t]*([A-Za-z][A-Za-z0-9-]*)(?:[ \t]*=[ \t]*|[ \t]+)(.+?)[ \t]*$/;
const VFOLDER_TAG_LINE = /^[ \t]*#[ \t]*vFolderTag:[ \t]*(.*?)[ \t]*$/i;

/**
 * Reads the host patterns from a `Host` line.
 *
 * @param line A single config line.
 * @returns The patterns, or null when the line is not a Host line.
 */
function matchHostLine(line: string): string[] | null {
    const match = HOST_LINE.exec(line);
    if (!match) {
        return null;
    }
    const patterns = match[1].split(/[ \t]+/).filter(Boolean);
    return patterns.length > 0 ? patterns : null;
}

/**
 * A pattern with wildcards is a template (`Host *`), not a connectable host.
 *
 * @param pattern The host pattern.
 * @returns True when the pattern cannot name a single host.
 */
function isWildcard(pattern: string): boolean {
    return pattern.includes('*') || pattern.includes('?') || pattern.startsWith('!');
}

/**
 * Splits a config into the lines before the first `Host` and the host blocks.
 *
 * @param content The full config file content.
 * @returns The preamble lines and the ordered host blocks.
 */
function splitBlocks(content: string): { preamble: string[]; blocks: HostBlock[] } {
    const preamble: string[] = [];
    const blocks: HostBlock[] = [];
    let current: HostBlock | undefined;

    for (const line of content.split('\n')) {
        const patterns = matchHostLine(line);
        if (patterns) {
            if (current) {
                blocks.push(current);
            }
            current = { patterns, lines: [line] };
        } else if (current) {
            current.lines.push(line);
        } else {
            preamble.push(line);
        }
    }

    if (current) {
        blocks.push(current);
    }

    return { preamble, blocks };
}

/**
 * Drops blank lines from the end of a line array.
 *
 * @param lines The lines to trim.
 * @returns The lines without trailing blanks.
 */
function trimTrailingBlanks(lines: string[]): string[] {
    const result = [...lines];
    while (result.length > 0 && result[result.length - 1].trim() === '') {
        result.pop();
    }
    return result;
}

/**
 * Renders a preamble and a set of blocks back into config text.
 *
 * Blocks are separated by exactly one blank line and the file ends with a
 * single newline.
 *
 * @param preamble Lines preceding the first host block.
 * @param blocks The host blocks, in order.
 * @returns The rendered config content.
 */
function render(preamble: string[], blocks: HostBlock[]): string {
    const sections: string[] = [];

    const trimmedPreamble = trimTrailingBlanks(preamble);
    if (trimmedPreamble.length > 0) {
        sections.push(trimmedPreamble.join('\n'));
    }

    for (const block of blocks) {
        sections.push(trimTrailingBlanks(block.lines).join('\n'));
    }

    return sections.length > 0 ? `${sections.join('\n\n')}\n` : '';
}

/**
 * Strips a matching pair of surrounding double quotes from a directive value.
 *
 * @param value The raw directive value.
 * @returns The value without surrounding quotes.
 */
function unquote(value: string): string {
    return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/**
 * Applies one directive to a connection being parsed.
 *
 * ssh_config keywords are case-insensitive, so the key is lowercased before
 * dispatch -- `hostname`, `HostName` and `HOSTNAME` are all the same keyword.
 *
 * @param connection The connection to mutate.
 * @param key The directive keyword.
 * @param rawValue The directive value.
 */
function applyDirective(connection: SSHConnection, key: string, rawValue: string): void {
    const value = unquote(rawValue);

    switch (key.toLowerCase()) {
        case 'hostname':
            connection.hostname = value;
            break;
        case 'user':
            connection.user = value;
            break;
        case 'port': {
            const port = parseInt(value, 10);
            if (Number.isInteger(port) && port > 0 && port <= 65535) {
                connection.port = port;
            }
            break;
        }
        case 'identityfile':
            connection.identityFile = value;
            break;
        case 'proxyjump':
            connection.proxyJump = value;
            break;
        case 'proxycommand':
            connection.proxyCommand = value;
            break;
        case 'forwardagent':
            connection.forwardAgent = value.toLowerCase() === 'yes';
            break;
        case 'localforward':
            connection.localForward = [...(connection.localForward ?? []), value];
            break;
        case 'remoteforward':
            connection.remoteForward = [...(connection.remoteForward ?? []), value];
            break;
        case 'compression':
            connection.compression = value.toLowerCase() === 'yes';
            break;
        case 'serveraliveinterval': {
            const interval = parseInt(value, 10);
            if (Number.isInteger(interval)) {
                connection.serverAliveInterval = interval;
            }
            break;
        }
        case 'serveralivecountmax': {
            const countMax = parseInt(value, 10);
            if (Number.isInteger(countMax)) {
                connection.serverAliveCountMax = countMax;
            }
            break;
        }
        case 'loglevel':
            connection.logLevel = value;
            break;
        default:
            // Directives the extension does not model are preserved on disk by
            // the block-copying writer, so there is nothing to do here.
            break;
    }
}

/**
 * Parses every connectable host out of a config file.
 *
 * Wildcard blocks (`Host *`) are skipped: they configure other hosts rather
 * than naming one. A block without an explicit `HostName` falls back to its
 * alias, which is what the real ssh client does.
 *
 * @param content The config file content.
 * @returns One entry per connectable host, in file order.
 */
export function parseSshConfig(content: string): SSHConnection[] {
    const { blocks } = splitBlocks(content);
    const connections: SSHConnection[] = [];

    for (const block of blocks) {
        const host = block.patterns[0];
        if (isWildcard(host)) {
            continue;
        }

        const connection: SSHConnection = { host, hostname: '' };

        for (const line of block.lines.slice(1)) {
            const tagMatch = VFOLDER_TAG_LINE.exec(line);
            if (tagMatch) {
                connection.vFolderTag = tagMatch[1] || undefined;
                continue;
            }

            if (line.trim().startsWith('#')) {
                continue;
            }

            const directive = DIRECTIVE_LINE.exec(line);
            if (directive) {
                applyDirective(connection, directive[1], directive[2]);
            }
        }

        if (!connection.hostname) {
            connection.hostname = host;
        }

        connections.push(connection);
    }

    return connections;
}

/**
 * Serializes a connection into an ssh_config `Host` block.
 *
 * @param connection The connection to serialize.
 * @returns The block text, without a trailing newline.
 */
export function buildConnectionEntry(connection: SSHConnection): string {
    const lines: (string | null)[] = [
        `Host ${connection.host}`,
        connection.vFolderTag ? `  # vFolderTag: ${connection.vFolderTag}` : null,
        `  HostName ${connection.hostname || connection.host}`,
        connection.user ? `  User ${connection.user}` : null,
        connection.port ? `  Port ${connection.port}` : null,
        connection.identityFile ? `  IdentityFile ${connection.identityFile}` : null,
        connection.proxyJump ? `  ProxyJump ${connection.proxyJump}` : null,
        connection.proxyCommand ? `  ProxyCommand ${connection.proxyCommand}` : null,
        connection.forwardAgent !== undefined ? `  ForwardAgent ${connection.forwardAgent ? 'yes' : 'no'}` : null,
        ...(connection.localForward ?? []).map(spec => `  LocalForward ${spec}`),
        ...(connection.remoteForward ?? []).map(spec => `  RemoteForward ${spec}`),
        connection.compression !== undefined ? `  Compression ${connection.compression ? 'yes' : 'no'}` : null,
        connection.serverAliveInterval ? `  ServerAliveInterval ${connection.serverAliveInterval}` : null,
        connection.serverAliveCountMax ? `  ServerAliveCountMax ${connection.serverAliveCountMax}` : null,
        connection.logLevel ? `  LogLevel ${connection.logLevel}` : null,
    ];

    return lines.filter((line): line is string => line !== null).join('\n');
}

/**
 * Replaces the block for `connection.host`, or appends it when absent.
 *
 * Only the target block is rewritten; every other block is copied through
 * verbatim so unrelated directives and comments survive.
 *
 * @param content The current config content.
 * @param connection The connection to insert or update.
 * @returns The updated config content.
 */
export function upsertConnection(content: string, connection: SSHConnection): string {
    const { preamble, blocks } = splitBlocks(content);
    const replacement: HostBlock = {
        patterns: [connection.host],
        lines: buildConnectionEntry(connection).split('\n'),
    };

    const index = blocks.findIndex(block => block.patterns[0] === connection.host);
    if (index >= 0) {
        blocks[index] = replacement;
    } else {
        blocks.push(replacement);
    }

    return render(preamble, blocks);
}

/**
 * Removes the block whose first pattern is `host`.
 *
 * Comments that sit above the block belong to the user rather than to the
 * block, so they are kept.
 *
 * @param content The current config content.
 * @param host The host alias to remove.
 * @returns The updated config content.
 */
export function removeHost(content: string, host: string): string {
    const { preamble, blocks } = splitBlocks(content);
    return render(
        preamble,
        blocks.filter(block => block.patterns[0] !== host)
    );
}

/**
 * Reports whether a host block exists.
 *
 * @param content The config content.
 * @param host The host alias to look for.
 * @returns True when a block with that alias is present.
 */
export function hasHost(content: string, host: string): boolean {
    return splitBlocks(content).blocks.some(block => block.patterns[0] === host);
}
