import * as vscode from 'vscode';
import { Client } from 'ssh2';
import { quote } from './shell';

/** SSH_FX_PERMISSION_DENIED, as reported by an SFTP operation. */
const SFTP_PERMISSION_DENIED = 3;

/** The result of a command run through sudo. */
export interface SudoResult {
    code: number;
    stdout: Buffer;
    stderr: string;
}

/**
 * Recognises a failure caused by the remote user's permissions.
 *
 * SFTP reports a numeric status; a shell command reports a message. Both
 * shapes turn up depending on which path failed.
 *
 * @param error The error to inspect.
 * @returns True when the operation was refused for lack of permission.
 */
export function isPermissionDenied(error: unknown): boolean {
    if (!error) {
        return false;
    }

    const code = (error as { code?: number | string }).code;
    if (code === SFTP_PERMISSION_DENIED || code === 'EACCES' || code === 'EPERM') {
        return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /permission denied|not permitted|access denied/i.test(message);
}

/** Recognises sudo rejecting the password we supplied. */
function isAuthFailure(stderr: string): boolean {
    return /sorry, try again|incorrect password|authentication failure|no password was provided/i.test(stderr);
}

/**
 * Runs commands on a connection as root via sudo, prompting when needed.
 *
 * SFTP has no notion of sudo, so anything the logged-in user may not do has to
 * go through a shell channel instead. The password asked for is the remote
 * user's own, which is what sudo authenticates -- not root's, as `su` would
 * want. It is held in memory for the lifetime of the connection and never
 * written to disk, never placed in argv, and never logged: it is fed to
 * `sudo -S` on stdin.
 */
export class PrivilegeEscalation {
    private password?: string;

    /**
     * @param getClient Supplies the live SSH client, if any.
     * @param describeAccount Names the remote account in prompts, e.g.
     *   `deploy@web`. Read lazily, because the user may not be known until
     *   the connection is established.
     */
    constructor(
        private readonly getClient: () => Client | undefined,
        private readonly describeAccount: () => string
    ) {}

    /** Discards the cached password, e.g. on disconnect or a bad password. */
    forget(): void {
        this.password = undefined;
    }

    /**
     * Asks the user whether to retry a refused operation with sudo.
     *
     * @param description What the extension was trying to do.
     * @returns True when the user wants to retry with sudo.
     */
    async confirm(description: string): Promise<boolean> {
        const choice = await vscode.window.showWarningMessage(
            `Permission denied while trying to ${description}.`,
            { modal: true, detail: `Run it as root with sudo, as ${this.describeAccount()}?` },
            'Retry with sudo'
        );

        return choice === 'Retry with sudo';
    }

    /**
     * Runs a shell command through sudo.
     *
     * @param command The command line to run as root.
     * @param stdin Optional data piped to the command after the password.
     * @returns The command's exit code and output.
     * @throws If there is no connection, or the user cancels the prompt.
     */
    async run(command: string, stdin?: Buffer): Promise<SudoResult> {
        const client = this.getClient();
        if (!client) {
            throw new Error('SSH connection is not established.');
        }

        for (let attempt = 0; attempt < 2; attempt++) {
            const password = await this.requirePassword();
            // -S reads the password from stdin, -p '' silences the prompt so
            // it cannot be mistaken for command output.
            const result = await execute(client, `sudo -S -p '' /bin/sh -c ${quote(command)}`, password, stdin);

            if (result.code !== 0 && isAuthFailure(result.stderr)) {
                this.forget();
                if (attempt === 0) {
                    vscode.window.showWarningMessage('sudo did not accept that password. Try again.');
                    continue;
                }
            }

            return result;
        }

        throw new Error('sudo authentication failed.');
    }

    /**
     * Runs a command through sudo and fails if it did not succeed.
     *
     * @param command The command line to run as root.
     * @param stdin Optional data piped to the command.
     * @returns The command's stdout.
     */
    async runOrThrow(command: string, stdin?: Buffer): Promise<Buffer> {
        const result = await this.run(command, stdin);
        if (result.code !== 0) {
            throw new Error(result.stderr.trim() || `Command failed with exit code ${result.code}.`);
        }
        return result.stdout;
    }

    /** Returns the cached password, prompting for one if necessary. */
    private async requirePassword(): Promise<string> {
        if (this.password !== undefined) {
            return this.password;
        }

        const account = this.describeAccount();
        const entered = await vscode.window.showInputBox({
            password: true,
            ignoreFocusOut: true,
            title: `sudo password for ${account}`,
            // sudo authenticates the invoking user, not root, so this is the
            // remote user's own password rather than root's.
            prompt: `Password for ${account} on the remote host, used to run this action with sudo. Kept in memory for this session only.`,
        });

        if (entered === undefined) {
            throw new Error('sudo authentication cancelled.');
        }

        this.password = entered;
        return entered;
    }
}

/**
 * Runs one command on a channel, feeding it a password and optional stdin.
 *
 * @param client The SSH client.
 * @param command The full command line.
 * @param password Written first, which is what `sudo -S` consumes.
 * @param stdin Data written after the password.
 * @returns The command's exit code and output.
 */
function execute(client: Client, command: string, password: string, stdin?: Buffer): Promise<SudoResult> {
    return new Promise((resolve, reject) => {
        client.exec(command, (err, stream) => {
            if (err) {
                reject(err);
                return;
            }

            const stdout: Buffer[] = [];
            let stderr = '';

            stream.on('data', (chunk: Buffer) => stdout.push(chunk));
            stream.stderr.on('data', (chunk: Buffer) => {
                stderr += chunk.toString();
            });
            stream.on('close', (code: number) => resolve({ code: code ?? 0, stdout: Buffer.concat(stdout), stderr }));
            stream.on('error', reject);

            // sudo -S reads up to the first newline as the password; anything
            // after it belongs to the command being run.
            stream.write(`${password}\n`);
            if (stdin) {
                stream.write(stdin);
            }
            stream.end();
        });
    });
}

/** Builds the elevated command lines, with every path quoted. */
export const sudoCommands = {
    remove: (remotePath: string, recursive: boolean) => `rm -${recursive ? 'rf' : 'f'} -- ${quote(remotePath)}`,
    rename: (from: string, to: string) => `mv -- ${quote(from)} ${quote(to)}`,
    chmod: (remotePath: string, mode: string) => `chmod ${quote(mode)} -- ${quote(remotePath)}`,
    chown: (remotePath: string, owner: string, group: string) =>
        `chown ${quote(`${owner}:${group}`)} -- ${quote(remotePath)}`,
    mkdir: (remotePath: string) => `mkdir -- ${quote(remotePath)}`,
    touch: (remotePath: string) => `touch -- ${quote(remotePath)}`,
    read: (remotePath: string) => `cat -- ${quote(remotePath)}`,
    write: (remotePath: string) => `cat > ${quote(remotePath)}`,
};
