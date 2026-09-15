/**
 * Path handling for values that come out of ssh_config.
 *
 * OpenSSH resolves `~` itself, so a config written for the `ssh` command is
 * full of paths Node cannot open as they stand.
 */

import * as os from 'os';
import * as path from 'path';

/**
 * Expands a leading `~` to the current user's home directory.
 *
 * Only the current user's home is expanded. `~otheruser/...` is left as it is:
 * resolving another account's home needs the password database, and guessing
 * at it would be worse than leaving the path to fail visibly.
 *
 * @param value The path as written in the config.
 * @param home The home directory, for tests.
 * @returns The path with `~` resolved.
 */
export function expandHome(value: string, home: string = os.homedir()): string {
    const trimmed = value.trim();

    if (trimmed === '~') {
        return home;
    }

    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
        return path.join(home, trimmed.slice(2));
    }

    return trimmed;
}

/**
 * Resolves a path from a config file, which may be relative to that file.
 *
 * OpenSSH reads a relative path in the user config as relative to `~/.ssh`,
 * not to the working directory the editor happens to have.
 *
 * @param value The path as written in the config.
 * @param baseDir The directory relative paths are resolved against.
 * @param home The home directory, for tests.
 * @returns An absolute path.
 */
export function resolveConfigPath(value: string, baseDir: string, home: string = os.homedir()): string {
    const expanded = expandHome(value, home);
    return path.isAbsolute(expanded) ? expanded : path.join(baseDir, expanded);
}
