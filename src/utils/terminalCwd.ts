/**
 * Learning which directory a remote shell is in.
 *
 * A shell reports its working directory with OSC 7, the sequence every modern
 * terminal uses for exactly this. It arrives mixed into the ordinary output
 * stream and can be split across reads, so the scanner keeps a little state.
 *
 * Nothing here talks to a shell or to `vscode`: the parsing is the part worth
 * testing, and it is all string in, string out.
 */

/**
 * Most shells emit nothing unless asked, so the terminal asks once.
 *
 * The shell-specific halves sit inside `eval` strings on purpose. A plain
 * `precmd_functions+=(...)` is a parse error in dash and ash -- the shells on
 * most embedded and minimal hosts -- and a parse error cannot be guarded by a
 * test, because it happens before any test runs. Quoted, they are only parsed
 * by the shell that recognises them, and everything else runs the line in
 * silence.
 */
export const CWD_REPORT_SETUP =
    `if [ -n "\${BASH_VERSION:-}" ]; then ` +
    `eval '__smc_cwd() { printf "\\033]7;file://%s%s\\033\\\\" "\${HOSTNAME:-}" "$PWD"; }; ` +
    `PROMPT_COMMAND="__smc_cwd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"'; ` +
    `elif [ -n "\${ZSH_VERSION:-}" ]; then ` +
    `eval '__smc_cwd() { printf "\\033]7;file://%s%s\\033\\\\" "\${HOST:-}" "$PWD"; }; ` +
    `precmd_functions+=(__smc_cwd)'; fi`;

/** How much of a partial sequence to hold before giving up on it. */
const MAX_PENDING = 4096;

/** The sequences this scanner reads; anything else is output, not a report. */
const PREFIXES = ['\x1b]7;', '\x1b]1337;CurrentDir='];

/**
 * Reads the directory out of an OSC 7 payload.
 *
 * The payload is a file URI whose authority is the host, which is of no use
 * here: the path is what the tree needs. Percent escapes are decoded, so a
 * directory with a space arrives intact.
 *
 * @param payload The text between `ESC ] 7 ;` and the terminator.
 * @returns The directory, or undefined when the payload is not a file URI.
 */
export function directoryFromOsc7(payload: string): string | undefined {
    const match = /^file:\/\/[^/]*(\/.*)$/.exec(payload.trim());
    if (!match) {
        return undefined;
    }

    try {
        const decoded = decodeURIComponent(match[1]);
        return decoded.length > 1 ? decoded.replace(/\/+$/, '') : decoded;
    } catch {
        // A malformed escape is not worth failing the whole stream over.
        return undefined;
    }
}

/**
 * Finds directory reports in a terminal's output stream.
 *
 * Both OSC 7 (`ESC ] 7 ; file://host/path`) and iTerm's
 * `ESC ] 1337 ; CurrentDir=/path` are understood, either terminated by BEL or
 * by ST. A sequence split across two reads is carried over rather than lost.
 */
export class CwdScanner {
    private pending = '';

    /**
     * Feeds a chunk of output through the scanner.
     *
     * The reports are taken out of the text on the way past. They are meant
     * for this extension, and VS Code makes its own use of them otherwise: it
     * records the directory as the terminal's own and starts the next split
     * terminal there -- a remote path, on the local machine, which fails with
     * "Starting directory does not exist".
     *
     * @param chunk Bytes as they arrived from the shell.
     * @returns The directories reported, and the output with them removed.
     */
    push(chunk: string): { directories: string[]; text: string } {
        const buffer = this.pending + chunk;
        const found: string[] = [];

        let cleaned = '';
        let consumed = 0;
        const pattern = /\x1b\]((?:7;)|(?:1337;CurrentDir=))([^\x07\x1b]*)(\x07|\x1b\\)/g;

        for (let match = pattern.exec(buffer); match; match = pattern.exec(buffer)) {
            const directory = match[1] === '7;' ? directoryFromOsc7(match[2]) : match[2].trim() || undefined;

            if (directory) {
                found.push(directory);
            }

            cleaned += buffer.slice(consumed, match.index);
            consumed = match.index + match[0].length;
        }

        // Anything that might be the start of another sequence is held back,
        // so half of one is never shown and never reaches VS Code.
        const tail = buffer.slice(consumed);
        this.pending = this.carry(tail);

        return { directories: found, text: cleaned + tail.slice(0, tail.length - this.pending.length) };
    }

    /**
     * Keeps the tail that might be the start of one of our sequences.
     *
     * Only ours: an escape that cannot become a directory report -- the window
     * title, say, which every shell sends -- is let through at once. Holding
     * any escape would swallow that output until the buffer overflowed.
     *
     * @param tail What is left after the last complete sequence.
     * @returns The part worth holding on to.
     */
    private carry(tail: string): string {
        const start = tail.lastIndexOf('\x1b]');
        if (start === -1) {
            return '';
        }

        const partial = tail.slice(start);
        if (partial.length > MAX_PENDING) {
            // Too long to be one of ours; stop growing on binary output.
            return '';
        }

        const couldBecomeOurs = PREFIXES.some(prefix => prefix.startsWith(partial) || partial.startsWith(prefix));

        return couldBecomeOurs ? partial : '';
    }
}
