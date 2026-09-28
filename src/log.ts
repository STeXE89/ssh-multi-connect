/**
 * Where this extension says what it is doing.
 *
 * Everything used to go to `console`, which only reaches the extension host's
 * own log: invisible to the user, and awkward even for a developer. A log
 * output channel puts the same lines under **Output → SSH Multi Connect**,
 * where someone hitting a problem can read them and send them on.
 *
 * VS Code owns the level: the channel honours the one chosen in the Output
 * view, so `debug` and `trace` cost nothing until somebody turns them up.
 */

import * as vscode from 'vscode';

/** Undefined until the extension activates, so tests can use the logger too. */
let channel: vscode.LogOutputChannel | undefined;

/**
 * Opens the channel. Called once, from activation.
 *
 * @param context The extension context, which disposes the channel.
 * @returns The channel, for anything that wants to show it.
 */
export function initLogging(context: vscode.ExtensionContext): vscode.LogOutputChannel {
    channel = vscode.window.createOutputChannel('SSH Multi Connect', { log: true });
    context.subscriptions.push(channel);
    return channel;
}

/**
 * Renders the extra values a log call carries.
 *
 * An Error's message is what matters; anything else is stringified rather than
 * printed as `[object Object]`.
 *
 * @param details The values passed after the message.
 * @returns One string, or an empty one when there were none.
 */
function describe(details: unknown[]): string {
    return details
        .map(detail => {
            if (detail instanceof Error) {
                return detail.message;
            }
            if (typeof detail === 'string') {
                return detail;
            }
            try {
                return JSON.stringify(detail);
            } catch {
                return String(detail);
            }
        })
        .join(' ');
}

/** Joins a message with its details. */
function line(message: string, details: unknown[]): string {
    const extra = describe(details);
    return extra ? `${message} ${extra}` : message;
}

/**
 * Writes one line, and never lets logging break the caller.
 *
 * A channel disposed while something is still shutting down throws on use; a
 * log call is never important enough to take an operation down with it, so it
 * falls back to the console and carries on.
 *
 * @param level The channel method to use.
 * @param text The line to write.
 */
function write(level: 'info' | 'warn' | 'error' | 'debug', text: string): void {
    try {
        if (channel) {
            channel[level](text);
            return;
        }
    } catch {
        // Falls through to the console below.
    }

    if (level !== 'debug') {
        console[level === 'info' ? 'log' : level](text);
    }
}

/**
 * The extension's log.
 *
 * Before activation, and in tests, the calls fall back to the console rather
 * than being dropped.
 */
export const log = {
    /** Routine progress: connecting, tunnels opening, files moving. */
    info(message: string, ...details: unknown[]): void {
        write('info', line(message, details));
    },

    /** Something the user may want to know about, that is not a failure. */
    warn(message: string, ...details: unknown[]): void {
        write('warn', line(message, details));
    },

    /** Something went wrong, whether or not it was reported on screen. */
    error(message: string, ...details: unknown[]): void {
        write('error', line(message, details));
    },

    /** Detail worth having only when a problem is being chased. */
    debug(message: string, ...details: unknown[]): void {
        write('debug', line(message, details));
    },
};

/** Brings the channel to the front, for a command that offers to show it. */
export function showLog(): void {
    try {
        channel?.show(true);
    } catch {
        // A disposed channel cannot be shown; nothing to do about it.
    }
}
