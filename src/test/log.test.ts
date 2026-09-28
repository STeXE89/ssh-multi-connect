import * as assert from 'assert';
import * as vscode from 'vscode';
import { log, initLogging, showLog } from '../log';

suite('log', () => {
    test('works before the channel exists, which is how tests reach it', () => {
        // No throw is the whole assertion: an unopened channel must not turn a
        // log line into a failure.
        assert.doesNotThrow(() => {
            log.info('before activation');
            log.warn('before activation');
            log.error('before activation', new Error('boom'));
            log.debug('before activation');
            showLog();
        });
    });

    test('renders an Error as its message, not as [object Object]', () => {
        const written: string[] = [];
        const channel = {
            info: (line: string) => written.push(line),
            warn: () => undefined,
            error: () => undefined,
            debug: () => undefined,
            show: () => undefined,
            dispose: () => undefined,
        };

        const created = vscode.window.createOutputChannel;
        (vscode.window as { createOutputChannel: unknown }).createOutputChannel = () => channel;

        try {
            initLogging({ subscriptions: [] } as unknown as vscode.ExtensionContext);
            log.info('could not connect', new Error('host unreachable'));

            assert.deepStrictEqual(written, ['could not connect host unreachable']);
        } finally {
            (vscode.window as { createOutputChannel: unknown }).createOutputChannel = created;
        }
    });

    test('opens a real channel on activation', () => {
        const channel = initLogging({ subscriptions: [] } as unknown as vscode.ExtensionContext);

        assert.strictEqual(channel.name, 'SSH Multi Connect');
    });

    test('a disposed channel does not take the caller down with it', () => {
        const channel = initLogging({ subscriptions: [] } as unknown as vscode.ExtensionContext);
        channel.dispose();

        // The extension logs during activation; a channel disposed underneath
        // it must not turn that into a failure to activate.
        assert.doesNotThrow(() => log.info('after dispose'));
    });
});
