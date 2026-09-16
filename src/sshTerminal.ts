import * as vscode from 'vscode';
import { Client, ClientChannel } from 'ssh2';
import { CWD_REPORT_SETUP, CwdScanner } from './utils/terminalCwd';

/** Fallback terminal size used before VS Code reports real dimensions. */
const DEFAULT_ROWS = 24;
const DEFAULT_COLUMNS = 80;

/**
 * A VS Code terminal backed by the extension's existing SSH connection.
 *
 * Opening a shell channel on the already-authenticated connection avoids a
 * second login, keeps secrets out of any child process, and needs neither
 * `sshpass` nor a local shell, so it behaves the same on every platform.
 */
export class SSHPseudoterminal implements vscode.Pseudoterminal {
    private readonly writeEmitter = new vscode.EventEmitter<string>();
    private readonly closeEmitter = new vscode.EventEmitter<number | void>();
    private readonly directoryEmitter = new vscode.EventEmitter<string>();

    readonly onDidWrite: vscode.Event<string> = this.writeEmitter.event;
    readonly onDidClose: vscode.Event<number | void> = this.closeEmitter.event;

    /** Fires with the shell's working directory whenever it reports one. */
    readonly onDidChangeDirectory: vscode.Event<string> = this.directoryEmitter.event;

    private channel?: ClientChannel;
    private closed = false;
    private readonly scanner = new CwdScanner();

    /**
     * @param client The connection to open a shell on.
     * @param reportDirectory Whether to ask the shell to report where it is.
     */
    constructor(
        private readonly client: Client,
        private readonly reportDirectory = false
    ) {}

    /**
     * Opens the remote shell channel once VS Code shows the terminal.
     *
     * @param initialDimensions The terminal size, if VS Code already knows it.
     */
    open(initialDimensions: vscode.TerminalDimensions | undefined): void {
        const rows = initialDimensions?.rows ?? DEFAULT_ROWS;
        const cols = initialDimensions?.columns ?? DEFAULT_COLUMNS;

        this.client.shell({ rows, cols, term: 'xterm-256color' }, (err, channel) => {
            if (err) {
                this.writeEmitter.fire(`\r\nFailed to open the remote shell: ${err.message}\r\n`);
                this.closeEmitter.fire(1);
                return;
            }

            if (this.closed) {
                // Dismissed while the channel was still being negotiated.
                channel.end();
                return;
            }

            this.channel = channel;

            channel.on('data', (data: Buffer) => {
                const text = data.toString('utf-8');

                // The sequences stay in the stream: the terminal knows what to
                // do with them, and stripping them risks cutting real output.
                for (const directory of this.scanner.push(text)) {
                    this.directoryEmitter.fire(directory);
                }

                this.writeEmitter.fire(text);
            });
            channel.stderr.on('data', (data: Buffer) => this.writeEmitter.fire(data.toString('utf-8')));
            channel.on('close', () => this.closeEmitter.fire());
            channel.on('error', (channelError: Error) =>
                this.writeEmitter.fire(`\r\nRemote shell error: ${channelError.message}\r\n`)
            );

            if (this.reportDirectory) {
                // Asked for once, before the first prompt, so the shell reports
                // where it is from then on. Most shells report nothing unless
                // told to, which is why this cannot be passive.
                channel.write(`${CWD_REPORT_SETUP}\n`);
            }
        });
    }

    /** Closes the remote shell when the terminal is disposed. */
    close(): void {
        this.closed = true;
        this.channel?.end();
        this.channel = undefined;
        this.directoryEmitter.dispose();
    }

    /**
     * Forwards keystrokes to the remote shell.
     *
     * Also serves `Terminal.sendText`, which VS Code routes here for
     * extension-owned terminals; that is how the multi-command panel sends.
     *
     * @param data The input to send.
     */
    handleInput(data: string): void {
        this.channel?.write(data);
    }

    /**
     * Propagates a resize so the remote side rewraps correctly.
     *
     * @param dimensions The new terminal size.
     */
    setDimensions(dimensions: vscode.TerminalDimensions): void {
        this.channel?.setWindow(dimensions.rows, dimensions.columns, 0, 0);
    }
}
