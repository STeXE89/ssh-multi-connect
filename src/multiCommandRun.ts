/**
 * Runs one command on several hosts at once and collects what each said.
 *
 * This is deliberately not the terminal path: a command sent to a terminal
 * interleaves with whatever the user is doing there, and its output cannot be
 * read back. Here each host gets its own exec channel, so stdout, stderr and
 * the exit status all belong to the command that was asked for.
 */

import { Client } from 'ssh2';
import { CommandResult } from './utils/commandResults';

/** A host to run on. */
export interface CommandTarget {
    host: string;
    client: Client;
}

/**
 * Runs a command on one host.
 *
 * A command that cannot be started, or whose channel fails, is reported as a
 * result with an error rather than rejecting: one unreachable host should not
 * lose the output of the others.
 *
 * @param target The host and its live client.
 * @param command The command to run.
 * @returns What the host did.
 */
export function runOnHost(target: CommandTarget, command: string): Promise<CommandResult> {
    return new Promise(resolve => {
        const finish = (result: Omit<CommandResult, 'host'>) => resolve({ host: target.host, ...result });

        target.client.exec(command, (error, stream) => {
            if (error) {
                finish({ stdout: '', stderr: '', error: error.message });
                return;
            }

            let stdout = '';
            let stderr = '';

            stream.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
            stream.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
            stream.on('error', (streamError: Error) => finish({ stdout, stderr, error: streamError.message }));

            // `close` carries the exit status; `end` does not.
            stream.on('close', (code: number | null, signal: string | undefined) =>
                finish({
                    stdout,
                    stderr,
                    ...(code === null || code === undefined
                        ? { error: signal ? `killed by ${signal}` : 'closed without an exit status' }
                        : { code }),
                })
            );
        });
    });
}

/**
 * Runs a command on every host, in parallel.
 *
 * @param targets The hosts.
 * @param command The command to run.
 * @param onDone Called as each host finishes, for progress.
 * @returns The results, in the order the hosts were given.
 */
export async function runOnHosts(
    targets: CommandTarget[],
    command: string,
    onDone?: (result: CommandResult) => void
): Promise<CommandResult[]> {
    return Promise.all(
        targets.map(target =>
            runOnHost(target, command).then(result => {
                onDone?.(result);
                return result;
            })
        )
    );
}
