import * as assert from 'assert';
import {
    escapeHtml,
    toSymbolicMode,
    formatBytes,
    renderDetails,
    renderEditor,
    renderEmpty,
    RemoteFileInfo,
} from '../fileDetailsView';

function info(overrides: Partial<RemoteFileInfo> = {}): RemoteFileInfo {
    return {
        path: '/etc/hosts',
        type: 'File',
        size: '212 B',
        modified: '01/01/2026, 10:00:00',
        created: 'Unavailable',
        permissions: '644',
        uid: '0',
        gid: '0',
        owner: 'root (0)',
        group: 'root (0)',
        ...overrides,
    };
}

suite('fileDetailsView: toSymbolicMode', () => {
    test('converts common modes', () => {
        assert.strictEqual(toSymbolicMode('755'), 'rwxr-xr-x');
        assert.strictEqual(toSymbolicMode('644'), 'rw-r--r--');
        assert.strictEqual(toSymbolicMode('600'), 'rw-------');
        assert.strictEqual(toSymbolicMode('777'), 'rwxrwxrwx');
        assert.strictEqual(toSymbolicMode('000'), '---------');
    });

    test('rejects anything that is not three octal digits', () => {
        assert.strictEqual(toSymbolicMode('7555'), '---------');
        assert.strictEqual(toSymbolicMode('89a'), '---------');
        assert.strictEqual(toSymbolicMode(''), '---------');
    });
});

suite('fileDetailsView: formatBytes', () => {
    test('shows small sizes in bytes', () => {
        assert.strictEqual(formatBytes(0), '0 B');
        assert.strictEqual(formatBytes(512), '512 B');
    });

    test('scales up and keeps the exact count', () => {
        assert.match(formatBytes(2048), /^2\.0 kB \(2,048 bytes\)$/);
        assert.match(formatBytes(5 * 1024 * 1024), /^5\.0 MB /);
    });

    test('handles nonsense input', () => {
        assert.strictEqual(formatBytes(-1), 'Unknown');
        assert.strictEqual(formatBytes(Number.NaN), 'Unknown');
    });
});

suite('fileDetailsView: escaping', () => {
    test('escapes HTML metacharacters', () => {
        assert.strictEqual(escapeHtml('<script>&"\''), '&lt;script&gt;&amp;&quot;&#39;');
    });

    test('a hostile remote filename cannot inject markup', () => {
        // Filenames come from the remote host, so they are untrusted.
        const hostile = '</div><img src=x onerror=alert(1)>';

        const html = renderDetails(info({ path: `/tmp/${hostile}` }));

        assert.ok(!html.includes('<img src=x'));
        assert.ok(html.includes('&lt;img src=x'));
    });

    test('a hostile account name cannot inject markup', () => {
        const html = renderEditor(info(), [{ name: '"><script>', id: '0' }], [{ name: 'root', id: '0' }]);

        assert.ok(!html.includes('"><script>'));
        assert.ok(html.includes('&quot;&gt;&lt;script&gt;'));
    });
});

suite('fileDetailsView: read-only details', () => {
    test('shows the facts and both mode forms', () => {
        const html = renderDetails(info({ permissions: '755' }));

        assert.ok(html.includes('/etc/hosts'));
        assert.ok(html.includes('rwxr-xr-x'));
        assert.ok(html.includes('>755<'));
        assert.ok(html.includes('root (0)'));
    });

    test('carries no editing controls', () => {
        // Selection shows information only; changes go through the edit form.
        const html = renderDetails(info());

        assert.ok(!html.includes('<input'));
        assert.ok(!html.includes('<select'));
        assert.ok(!html.includes('applyButton'));
    });

    test('offers an Edit Permissions button that opens the form', () => {
        const html = renderDetails(info());

        assert.ok(html.includes('id="editButton"'));
        assert.match(html, /command: 'editPermissions'/);
    });

    test('runs under a content security policy with a script nonce', () => {
        const html = renderDetails(info());
        const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];

        assert.ok(nonce);
        assert.ok(html.includes(`'nonce-${nonce}'`));
    });
});

suite('fileDetailsView: editor', () => {
    test('checks the boxes matching the current mode', () => {
        const html = renderEditor(info({ permissions: '640' }), [], []);

        // owner rw-, group r--, others ---
        assert.match(html, /id="ownerRead" data-bit checked/);
        assert.match(html, /id="ownerWrite" data-bit checked/);
        assert.match(html, /id="ownerExecute" data-bit>/);
        assert.match(html, /id="groupRead" data-bit checked/);
        assert.match(html, /id="othersRead" data-bit>/);
    });

    test('preselects the current owner and group', () => {
        const html = renderEditor(
            info({ uid: '1000', gid: '1000' }),
            [
                { name: 'root', id: '0' },
                { name: 'me', id: '1000' },
            ],
            [{ name: 'me', id: '1000' }]
        );

        assert.match(html, /<option value="1000" selected>me \(1000\)<\/option>/);
        assert.ok(!html.includes('<option value="0" selected>'));
    });

    test('offers Apply and Cancel', () => {
        const html = renderEditor(info(), [], []);

        assert.ok(html.includes('id="applyButton"'));
        assert.ok(html.includes('id="cancelButton"'));
    });

    test('warns that changing ownership needs privileges', () => {
        assert.match(renderEditor(info(), [], []), /requires root/);
    });

    test('runs its script under a nonce', () => {
        const html = renderEditor(info(), [], []);
        const nonce = /<script nonce="([^"]+)">/.exec(html)?.[1];

        assert.ok(nonce);
        assert.ok(html.includes(`'nonce-${nonce}'`));
    });
});

suite('fileDetailsView: empty state', () => {
    test('prompts the user to select something', () => {
        assert.match(renderEmpty(), /Select a file or folder/);
    });
});
