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

/**
 * Removes one known echo from a terminal stream.
 *
 * The shell echoes whatever is typed into it, so the line that sets up
 * directory reporting appears in the terminal: a wall of shell syntax at the
 * top of every session, which looks alarming and explains nothing. It is
 * removed on its way to the terminal, once.
 *
 * Only an exact match is removed. If the stream does not contain the text --
 * a shell that does not echo, or one that rewraps what it echoes -- the
 * suppressor gives up and lets everything through, which is no worse than not
 * having tried.
 */
export class EchoSuppressor {
    private held = '';
    private seen = 0;
    private done = false;

    /**
     * @param text The line that was sent, and should not be shown.
     * @param budget How much output to watch before giving up.
     */
    constructor(
        private readonly text: string,
        private readonly budget = 16384
    ) {
        this.done = text.length === 0;
    }

    /**
     * Passes output through, minus the echo.
     *
     * @param chunk Output as it arrived.
     * @returns What the terminal should show.
     */
    push(chunk: string): string {
        if (this.done) {
            return chunk;
        }

        this.seen += chunk.length;
        const buffer = this.held + chunk;

        const at = buffer.indexOf(this.text);
        if (at !== -1) {
            this.done = true;
            this.held = '';

            // The newline that ended the line goes too, so the terminal is not
            // left with a blank line where the command was.
            const after = at + this.text.length;
            const rest = buffer.slice(after).replace(/^\r?\n/, '');
            return buffer.slice(0, at) + rest;
        }

        if (this.seen > this.budget) {
            this.done = true;
            this.held = '';
            return buffer;
        }

        // Whatever could still turn out to be the start of the echo is held
        // back; everything before it is safe to show now.
        const keep = Math.min(this.text.length - 1, buffer.length);
        for (let length = keep; length > 0; length--) {
            if (this.text.startsWith(buffer.slice(buffer.length - length))) {
                this.held = buffer.slice(buffer.length - length);
                return buffer.slice(0, buffer.length - length);
            }
        }

        this.held = '';
        return buffer;
    }
}
