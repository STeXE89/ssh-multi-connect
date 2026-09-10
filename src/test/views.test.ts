import * as assert from 'assert';
import * as vscode from 'vscode';
import {
    SSHTreeDecorationProvider,
    connectionResourceUri,
    folderResourceUri,
    CONNECTION_SCHEME,
} from '../connectionDecorations';
import { FileDetailsViewProvider } from '../fileDetailsView';

suite('SSHTreeDecorationProvider: connections', () => {
    const provider = (connected: (id: string) => boolean) => new SSHTreeDecorationProvider(connected, () => 0);

    test('decorates a connected host', () => {
        const decoration = provider(id => id === 'live').provideFileDecoration(connectionResourceUri('live'));

        assert.ok(decoration);
        assert.ok(decoration.color instanceof vscode.ThemeColor);
        assert.strictEqual(decoration.tooltip, 'Connected');
    });

    test('leaves a disconnected host undecorated', () => {
        assert.strictEqual(provider(() => false).provideFileDecoration(connectionResourceUri('idle')), undefined);
    });

    test('ignores URIs from other schemes', () => {
        // The remote file tree carries real ssh:// URIs and must not be touched.
        const decorator = provider(() => true);

        assert.strictEqual(decorator.provideFileDecoration(vscode.Uri.parse('ssh://me@host:22/etc/hosts')), undefined);
        assert.strictEqual(decorator.provideFileDecoration(vscode.Uri.file('/tmp/x')), undefined);
    });

    test('round-trips the connection id through the URI', () => {
        const uri = connectionResourceUri('my-host');

        assert.strictEqual(uri.scheme, CONNECTION_SCHEME);
        assert.strictEqual(provider(id => id === 'my-host').provideFileDecoration(uri)?.tooltip, 'Connected');
    });
});

suite('SSHTreeDecorationProvider: folder badges', () => {
    const provider = (count: (path: string) => number) => new SSHTreeDecorationProvider(() => false, count);

    test('badges a folder with its connection count', () => {
        const decoration = provider(() => 3).provideFileDecoration(folderResourceUri('Prod'));

        assert.strictEqual(decoration?.badge, '3');
        assert.strictEqual(decoration?.tooltip, '3 connections');
    });

    test('uses the singular for one connection', () => {
        assert.strictEqual(provider(() => 1).provideFileDecoration(folderResourceUri('Prod'))?.tooltip, '1 connection');
    });

    test('leaves an empty folder unbadged', () => {
        assert.strictEqual(provider(() => 0).provideFileDecoration(folderResourceUri('Prod')), undefined);
    });

    test('keeps the badge within the two characters VS Code allows', () => {
        const badge = provider(() => 250).provideFileDecoration(folderResourceUri('Big'))?.badge;

        assert.ok(badge);
        assert.ok(badge.length <= 2, `badge "${badge}" is too long`);
    });

    test('passes the full nested path to the counter', () => {
        let seen = '';
        provider(path => {
            seen = path;
            return 1;
        }).provideFileDecoration(folderResourceUri('Prod/EU/West'));

        assert.strictEqual(seen, 'Prod/EU/West');
    });
});

/** Minimal stand-in for the webview view VS Code hands to a provider. */
function fakeWebviewView() {
    const listeners: ((message: unknown) => void)[] = [];
    let shownWithFocus: boolean | undefined;

    const view = {
        webview: {
            options: {},
            html: '',
            onDidReceiveMessage(listener: (message: unknown) => void) {
                listeners.push(listener);
                return { dispose() {} };
            },
        },
        show(preserveFocus?: boolean) {
            shownWithFocus = preserveFocus;
        },
    };

    return {
        view: view as unknown as vscode.WebviewView,
        post: (message: unknown) => listeners.forEach(listener => listener(message)),
        listenerCount: () => listeners.length,
        html: () => view.webview.html,
        wasShown: () => shownWithFocus !== undefined,
    };
}

const resolveContext = {} as vscode.WebviewViewResolveContext;
const token = {} as vscode.CancellationToken;

suite('FileDetailsViewProvider', () => {
    test('renders immediately once the view exists', async () => {
        const provider = new FileDetailsViewProvider();
        const fake = fakeWebviewView();
        provider.resolveWebviewView(fake.view, resolveContext, token);

        await provider.show('<p>details</p>');

        assert.strictEqual(fake.html(), '<p>details</p>');
    });

    test('holds content until the view is resolved', async () => {
        // A webview view does not exist until VS Code resolves it, which only
        // happens when it is revealed. Content must not be dropped meanwhile.
        const provider = new FileDetailsViewProvider();

        await provider.show('<p>queued</p>', false);
        const fake = fakeWebviewView();
        provider.resolveWebviewView(fake.view, resolveContext, token);

        assert.strictEqual(fake.html(), '<p>queued</p>');
    });

    test('does not focus the panel when reveal is off', async () => {
        const provider = new FileDetailsViewProvider();
        const fake = fakeWebviewView();
        provider.resolveWebviewView(fake.view, resolveContext, token);

        await provider.show('<p>x</p>', false);

        assert.strictEqual(fake.wasShown(), false);
    });

    test('focuses the panel when reveal is on', async () => {
        const provider = new FileDetailsViewProvider();
        const fake = fakeWebviewView();
        provider.resolveWebviewView(fake.view, resolveContext, token);

        await provider.show('<p>x</p>', true);

        assert.strictEqual(fake.wasShown(), true);
    });

    test('shows an empty state when nothing has been selected', () => {
        const provider = new FileDetailsViewProvider();
        const fake = fakeWebviewView();

        provider.resolveWebviewView(fake.view, resolveContext, token);

        assert.match(fake.html(), /Select a file or folder/);
    });

    test('attaches exactly one webview listener', () => {
        const provider = new FileDetailsViewProvider();
        const fake = fakeWebviewView();

        provider.resolveWebviewView(fake.view, resolveContext, token);
        provider.setMessageHandler(() => {});
        provider.setMessageHandler(() => {});

        assert.strictEqual(fake.listenerCount(), 1);
    });

    test('replaces the handler rather than stacking it', () => {
        // Handlers used to accumulate per open, so Apply acted on every file
        // visited earlier in the session as well as the current one.
        const provider = new FileDetailsViewProvider();
        const fake = fakeWebviewView();
        provider.resolveWebviewView(fake.view, resolveContext, token);

        const seen: string[] = [];
        provider.setMessageHandler(() => seen.push('first'));
        provider.setMessageHandler(() => seen.push('second'));
        fake.post({ command: 'applyPermissions' });

        assert.deepStrictEqual(seen, ['second']);
    });

    test('a message with no handler set is harmless', () => {
        const provider = new FileDetailsViewProvider();
        const fake = fakeWebviewView();
        provider.resolveWebviewView(fake.view, resolveContext, token);

        assert.doesNotThrow(() => fake.post({ command: 'applyPermissions' }));
    });
});
