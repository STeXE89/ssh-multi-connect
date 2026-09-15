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
     * @param chunk Bytes as they arrived from the shell.
     * @returns Every directory reported in this chunk, in order.
     */
    push(chunk: string): string[] {
        const text = this.pending + chunk;
        const found: string[] = [];

        // Anything before the last escape is complete; what follows may not be.
        let consumed = 0;
        const pattern = /\x1b\]((?:7;)|(?:1337;CurrentDir=))([^\x07\x1b]*)(\x07|\x1b\\)/g;

        for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
            const directory = match[1] === '7;' ? directoryFromOsc7(match[2]) : match[2].trim() || undefined;

            if (directory) {
                found.push(directory);
            }
            consumed = match.index + match[0].length;
        }

        this.pending = this.carry(text.slice(consumed));
        return found;
    }

    /**
     * Keeps the tail that might be the start of a split sequence.
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
        // A sequence this long is not one of ours; drop it rather than grow
        // without bound on binary output.
        return partial.length <= MAX_PENDING ? partial : '';
    }
}
