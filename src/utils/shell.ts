/**
 * Helpers for building shell command lines safely.
 *
 * Anything reaching a shell must go through `quote`: filenames listed over
 * SFTP, host keys returned by a server and uid/gid values picked in a webview
 * are all outside the user's control.
 *
 * The quoting is POSIX on every platform by design. The only callers build
 * commands run on the *remote* host (`du`, `chown`), whose shell is POSIX
 * whatever the local machine runs, so do not port this to cmd.exe quoting.
 */

/**
 * Quotes a single argument for POSIX shells.
 *
 * Wraps the value in single quotes and escapes any embedded single quote by
 * closing the quoted run, emitting an escaped quote and reopening it. The
 * result is safe to interpolate into a command string.
 *
 * @param arg The raw argument value.
 * @returns The argument, quoted for a POSIX shell.
 */
export function quote(arg: string): string {
    if (arg === '') {
        return "''";
    }
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Quotes each argument and joins them with spaces.
 *
 * @param args The raw argument values.
 * @returns A space-separated, fully quoted argument list.
 */
export function quoteAll(args: string[]): string {
    return args.map(quote).join(' ');
}

/**
 * Rejects values that cannot be a valid hostname or IP address.
 *
 * Used as a guard before a hostname reaches `ssh-keyscan`/`ssh-keygen`, so that
 * a hostile ssh_config entry cannot smuggle shell metacharacters through even
 * if a call site forgets to quote.
 *
 * @param hostname The hostname to validate.
 * @returns True when the value only contains hostname-safe characters.
 */
export function isValidHostname(hostname: string): boolean {
    return /^[A-Za-z0-9._:[\]-]+$/.test(hostname) && hostname.length <= 253;
}
