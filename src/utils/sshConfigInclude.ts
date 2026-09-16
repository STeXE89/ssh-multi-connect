/**
 * Following `Include` directives, so a config assembled from several files is
 * read the way `ssh` reads it.
 *
 * A split config (`Include ~/.ssh/config.d/*`) is common, and without this the
 * hosts in those files are invisible. The filesystem arrives as an injected
 * reader, so the awkward parts -- globs, relative paths, recursion -- can be
 * tested without touching a real `~/.ssh`.
 */

import { resolveConfigPath } from './paths';

/** The filesystem, as this module needs it. */
export interface ConfigReader {
    /** Returns the file's content, or undefined when it cannot be read. */
    read(path: string): string | undefined;
    /** Lists a directory's entries, or undefined when it is not one. */
    list(directory: string): string[] | undefined;
}

/** One line of the assembled config, and the file it came from. */
export interface SourcedLine {
    text: string;
    file: string;
}

/** Where a host is defined, and whether its block can be rewritten. */
export interface HostOrigin {
    file: string;
    /**
     * Set when the block pulls in another file. Rewriting such a block from
     * the model would drop the `Include` line and silently change the config,
     * so those blocks are left alone.
     */
    spansIncludes: boolean;
}

const INCLUDE_LINE = /^[ \t]*Include(?:[ \t]*=[ \t]*|[ \t]+)(.+?)[ \t]*$/i;
const HOST_LINE = /^[ \t]*Host(?:[ \t]*=[ \t]*|[ \t]+)(.+?)[ \t]*$/i;

/**
 * OpenSSH's own limit on how deeply configs may include one another. It also
 * stops a cycle, which is otherwise the obvious way to hang here.
 */
const MAX_DEPTH = 16;

/**
 * Reads a config and everything it includes, in order.
 *
 * A file that cannot be read is skipped rather than failing the whole config:
 * one stale `Include` line should not hide every host.
 *
 * @param rootPath The config file to start from.
 * @param reader The filesystem.
 * @param baseDir The directory relative includes resolve against, normally `~/.ssh`.
 * @param home The home directory, for tests.
 * @returns Every line, in the order `ssh` would read them.
 */
export function flattenConfig(rootPath: string, reader: ConfigReader, baseDir: string, home?: string): SourcedLine[] {
    const seen = new Set<string>();

    const walk = (filePath: string, depth: number): SourcedLine[] => {
        if (depth > MAX_DEPTH || seen.has(filePath)) {
            return [];
        }
        seen.add(filePath);

        const content = reader.read(filePath);
        if (content === undefined) {
            return [];
        }

        const lines: SourcedLine[] = [];
        for (const text of content.split('\n')) {
            const include = INCLUDE_LINE.exec(text);
            if (!include) {
                lines.push({ text, file: filePath });
                continue;
            }

            for (const pattern of splitPatterns(include[1])) {
                for (const included of expandGlob(resolveConfigPath(pattern, baseDir, home), reader)) {
                    lines.push(...walk(included, depth + 1));
                }
            }
        }

        return lines;
    };

    return walk(rootPath, 0);
}

/**
 * Records which file each host is defined in.
 *
 * @param lines The assembled config.
 * @returns The origin of every host, keyed by its name.
 */
export function hostOrigins(lines: SourcedLine[]): Map<string, HostOrigin> {
    const origins = new Map<string, HostOrigin>();
    let current: string[] = [];

    for (const line of lines) {
        const host = HOST_LINE.exec(line.text);

        if (host) {
            current = host[1].split(/[ \t]+/).filter(Boolean);
            for (const pattern of current) {
                origins.set(pattern, { file: line.file, spansIncludes: false });
            }
            continue;
        }

        // A line from another file, inside a block, can only have arrived
        // through an Include within that block.
        if (current.length > 0 && line.file !== origins.get(current[0])?.file) {
            for (const pattern of current) {
                const origin = origins.get(pattern);
                if (origin) {
                    origin.spansIncludes = true;
                }
            }
        }
    }

    return origins;
}

/**
 * Splits an `Include` value into its patterns, honouring double quotes.
 *
 * @param value The directive's value.
 * @returns The patterns.
 */
export function splitPatterns(value: string): string[] {
    return (value.match(/"[^"]*"|\S+/g) ?? []).map(token => token.replace(/^"|"$/g, '')).filter(Boolean);
}

/**
 * Expands a path that may contain wildcards in its last segments.
 *
 * `*`, `?` and `[...]` are supported, as in `ssh`; `**` is not, since OpenSSH
 * does not have it either. A pattern that matches nothing yields nothing,
 * which is what `ssh` does for a glob.
 *
 * @param pattern An absolute path, possibly with wildcards.
 * @param reader The filesystem.
 * @returns The matching paths, sorted, or the path itself when it has no
 * wildcards.
 */
export function expandGlob(pattern: string, reader: ConfigReader): string[] {
    if (!/[*?[]/.test(pattern)) {
        return [pattern];
    }

    const segments = pattern.split(/[/\\]/);
    let candidates = [segments[0] === '' ? '/' : segments[0]];

    for (const segment of segments.slice(1)) {
        if (segment === '') {
            continue;
        }

        if (!/[*?[]/.test(segment)) {
            candidates = candidates.map(base => join(base, segment));
            continue;
        }

        const matcher = segmentMatcher(segment);
        candidates = candidates.flatMap(base =>
            (reader.list(base) ?? [])
                .filter(entry => matcher.test(entry))
                .sort()
                .map(entry => join(base, entry))
        );
    }

    return candidates;
}

/**
 * Joins a directory and an entry without depending on the host's separator,
 * since a config may name either.
 */
function join(base: string, entry: string): string {
    return base.endsWith('/') || base.endsWith('\\') ? `${base}${entry}` : `${base}/${entry}`;
}

/**
 * Builds the matcher for one wildcard path segment.
 *
 * @param segment The segment, containing at least one wildcard.
 * @returns A regular expression anchored to the whole segment.
 */
function segmentMatcher(segment: string): RegExp {
    let source = '';

    for (let index = 0; index < segment.length; index++) {
        const char = segment[index];

        if (char === '*') {
            source += '[^/\\\\]*';
        } else if (char === '?') {
            source += '[^/\\\\]';
        } else if (char === '[') {
            const close = segment.indexOf(']', index + 1);
            if (close === -1) {
                source += '\\[';
            } else {
                source += `[${segment.slice(index + 1, close).replace(/\\/g, '\\\\')}]`;
                index = close;
            }
        } else {
            source += char.replace(/[.+^${}()|\\]/g, '\\$&');
        }
    }

    // A leading dot is not matched by a wildcard, as in a shell.
    return new RegExp(`^(?!\\.)${source}$`);
}
