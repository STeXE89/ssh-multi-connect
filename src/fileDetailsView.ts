import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { SelectionSummary, describeSelection } from './utils/selectionSummary';

/** An account as listed in the remote /etc/passwd or /etc/group. */
export interface RemoteAccount {
    name: string;
    id: string;
}

/** Everything the details panel shows about one remote file or folder. */
export interface RemoteFileInfo {
    path: string;
    type: string;
    size: string;
    modified: string;
    created: string;
    /** Three-digit octal mode, e.g. `755`. */
    permissions: string;
    uid: string;
    gid: string;
    owner: string;
    group: string;
}

/**
 * Escapes a value for HTML text or a quoted attribute.
 *
 * Remote filenames, paths and account names come from the remote host, so they
 * must not be able to close a tag or attribute.
 *
 * @param value The raw value.
 * @returns The escaped value.
 */
export function escapeHtml(value: string | number): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Converts a three-digit octal mode to its `rwxr-xr-x` form.
 *
 * @param octal The mode, e.g. `755`.
 * @returns The symbolic form, or `---------` if the mode is unreadable.
 */
export function toSymbolicMode(octal: string): string {
    if (!/^[0-7]{3}$/.test(octal)) {
        return '---------';
    }

    return [...octal]
        .map(digit => {
            const bits = Number(digit);
            return `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
        })
        .join('');
}

/**
 * Formats a byte count for display.
 *
 * @param bytes The size in bytes.
 * @returns A short human-readable size.
 */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) {
        return 'Unknown';
    }
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    const units = ['kB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }

    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]} (${bytes.toLocaleString('en-US')} bytes)`;
}

const STYLES = `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
        margin: 0;
        padding: 12px;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: transparent;
    }
    h2 {
        margin: 0 0 2px;
        font-size: 1.05em;
        font-weight: 600;
        word-break: break-all;
    }
    .subtitle {
        margin-bottom: 14px;
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        word-break: break-all;
    }
    .section {
        margin-bottom: 16px;
    }
    p.summary {
        margin: 0 0 14px;
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
    }
    ul.selection {
        margin: 0;
        padding-left: 18px;
        max-height: 60vh;
        overflow-y: auto;
    }
    ul.selection li {
        word-break: break-all;
        line-height: 1.5;
    }
    .section-title {
        margin-bottom: 6px;
        font-size: 0.78em;
        font-weight: 600;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        color: var(--vscode-descriptionForeground);
    }
    dl.facts {
        display: grid;
        grid-template-columns: minmax(74px, auto) 1fr;
        gap: 4px 12px;
        margin: 0;
    }
    dl.facts dt {
        color: var(--vscode-descriptionForeground);
    }
    dl.facts dd {
        margin: 0;
        word-break: break-all;
    }
    .mode {
        font-family: var(--vscode-editor-font-family, monospace);
    }
    .mode .octal {
        margin-left: 8px;
        padding: 0 5px;
        border-radius: 3px;
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        font-size: 0.9em;
    }
    table.matrix {
        width: 100%;
        border-collapse: collapse;
    }
    table.matrix th,
    table.matrix td {
        padding: 4px 6px;
        text-align: center;
        border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,0.25));
    }
    table.matrix thead th {
        font-size: 0.78em;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--vscode-descriptionForeground);
    }
    table.matrix tbody th {
        text-align: left;
        font-weight: 400;
        color: var(--vscode-descriptionForeground);
    }
    table.matrix tbody tr:last-child th,
    table.matrix tbody tr:last-child td {
        border-bottom: none;
    }
    .bit {
        font-family: var(--vscode-editor-font-family, monospace);
    }
    .bit.on { color: var(--vscode-charts-green, var(--vscode-foreground)); }
    .bit.off { color: var(--vscode-descriptionForeground); opacity: 0.6; }
    label.field {
        display: block;
        margin-bottom: 10px;
    }
    label.field > span {
        display: block;
        margin-bottom: 3px;
        color: var(--vscode-descriptionForeground);
    }
    select {
        width: 100%;
        padding: 3px 4px;
        color: var(--vscode-dropdown-foreground);
        background: var(--vscode-dropdown-background);
        border: 1px solid var(--vscode-dropdown-border, transparent);
        border-radius: 2px;
    }
    .actions {
        display: flex;
        gap: 8px;
        margin-top: 4px;
    }
    button {
        flex: 1;
        padding: 5px 12px;
        font-family: inherit;
        font-size: inherit;
        border: none;
        border-radius: 2px;
        cursor: pointer;
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .hint {
        margin-top: 10px;
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
    }
    .empty {
        padding: 18px 4px;
        color: var(--vscode-descriptionForeground);
        text-align: center;
    }
`;

/**
 * Wraps body markup in a document with a script-nonce CSP.
 *
 * @param title The document title.
 * @param body The body markup.
 * @param script Optional script, run under the nonce.
 * @returns The complete HTML document.
 */
function page(title: string, body: string, script = ''): string {
    const nonce = randomBytes(16).toString('base64');
    const scriptTag = script ? `<script nonce="${nonce}">${script}</script>` : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${body}
${scriptTag}
</body>
</html>`;
}

/** Renders the read-only permission grid. */
function readOnlyMatrix(permissions: string): string {
    const rows = [
        ['Owner', Number(permissions[0] ?? 0)],
        ['Group', Number(permissions[1] ?? 0)],
        ['Others', Number(permissions[2] ?? 0)],
    ] as const;

    const cell = (bits: number, bit: number, glyph: string) =>
        `<td class="bit ${bits & bit ? 'on' : 'off'}">${bits & bit ? glyph : '–'}</td>`;

    return `
<table class="matrix">
    <thead><tr><th></th><th>Read</th><th>Write</th><th>Execute</th></tr></thead>
    <tbody>
        ${rows
            .map(
                ([label, bits]) => `<tr>
            <th>${label}</th>
            ${cell(bits, 4, 'r')}
            ${cell(bits, 2, 'w')}
            ${cell(bits, 1, 'x')}
        </tr>`
            )
            .join('')}
    </tbody>
</table>`;
}

/**
 * Renders the read-only details of a remote file or folder.
 *
 * @param info The item's details.
 * @returns The panel HTML.
 */
export function renderDetails(info: RemoteFileInfo): string {
    const name = info.path.split('/').filter(Boolean).pop() ?? info.path;

    const body = `
<h2>${escapeHtml(name)}</h2>
<div class="subtitle">${escapeHtml(info.path)}</div>

<div class="section">
    <div class="section-title">Details</div>
    <dl class="facts">
        <dt>Type</dt><dd>${escapeHtml(info.type)}</dd>
        <dt>Size</dt><dd>${escapeHtml(info.size)}</dd>
        <dt>Owner</dt><dd>${escapeHtml(info.owner)}</dd>
        <dt>Group</dt><dd>${escapeHtml(info.group)}</dd>
        <dt>Modified</dt><dd>${escapeHtml(info.modified)}</dd>
        <dt>Created</dt><dd>${escapeHtml(info.created)}</dd>
    </dl>
</div>

<div class="section">
    <div class="section-title">Permissions</div>
    <dl class="facts">
        <dt>Mode</dt>
        <dd class="mode">${escapeHtml(toSymbolicMode(info.permissions))}<span class="octal">${escapeHtml(info.permissions)}</span></dd>
    </dl>
</div>

<div class="section">
    ${readOnlyMatrix(info.permissions)}
</div>

<div class="actions">
    <button id="editButton">Edit Permissions</button>
</div>`;

    const script = `
const vscode = acquireVsCodeApi();
document.getElementById('editButton').addEventListener('click', () => {
    vscode.postMessage({ command: 'editPermissions' });
});`;

    return page('File Details', body, script);
}

/**
 * Renders the editable permissions form.
 *
 * @param info The item's current details.
 * @param users Selectable owners.
 * @param groups Selectable groups.
 * @returns The panel HTML.
 */
export function renderEditor(info: RemoteFileInfo, users: RemoteAccount[], groups: RemoteAccount[]): string {
    const name = info.path.split('/').filter(Boolean).pop() ?? info.path;

    const options = (accounts: RemoteAccount[], selectedId: string) =>
        accounts
            .map(
                account =>
                    `<option value="${escapeHtml(account.id)}"${account.id === selectedId ? ' selected' : ''}>${escapeHtml(account.name)} (${escapeHtml(account.id)})</option>`
            )
            .join('');

    const checkbox = (scope: string, action: string, bits: number, bit: number) =>
        `<td><input type="checkbox" id="${scope}${action}" data-bit${bits & bit ? ' checked' : ''}></td>`;

    const row = (label: string, scope: string, bits: number) => `<tr>
        <th>${label}</th>
        ${checkbox(scope, 'Read', bits, 4)}
        ${checkbox(scope, 'Write', bits, 2)}
        ${checkbox(scope, 'Execute', bits, 1)}
    </tr>`;

    const body = `
<h2>${escapeHtml(name)}</h2>
<div class="subtitle">${escapeHtml(info.path)}</div>

<div class="section">
    <div class="section-title">Permissions</div>
    <table class="matrix">
        <thead><tr><th></th><th>Read</th><th>Write</th><th>Execute</th></tr></thead>
        <tbody>
            ${row('Owner', 'owner', Number(info.permissions[0] ?? 0))}
            ${row('Group', 'group', Number(info.permissions[1] ?? 0))}
            ${row('Others', 'others', Number(info.permissions[2] ?? 0))}
        </tbody>
    </table>
    <dl class="facts" style="margin-top:10px">
        <dt>Mode</dt>
        <dd class="mode"><span id="symbolic">${escapeHtml(toSymbolicMode(info.permissions))}</span><span class="octal" id="octal">${escapeHtml(info.permissions)}</span></dd>
    </dl>
</div>

<div class="section">
    <div class="section-title">Ownership</div>
    <label class="field"><span>User</span><select id="userSelect">${options(users, info.uid)}</select></label>
    <label class="field"><span>Group</span><select id="groupSelect">${options(groups, info.gid)}</select></label>
    <div class="hint">Changing owner or group normally requires root on the remote host.</div>
</div>

<div class="actions">
    <button id="applyButton">Apply</button>
    <button id="cancelButton" class="secondary">Cancel</button>
</div>`;

    const script = `
const vscode = acquireVsCodeApi();
const scopes = ['owner', 'group', 'others'];

function bitsFor(scope) {
    return (document.getElementById(scope + 'Read').checked ? 4 : 0)
         + (document.getElementById(scope + 'Write').checked ? 2 : 0)
         + (document.getElementById(scope + 'Execute').checked ? 1 : 0);
}

function octal() {
    return scopes.map(bitsFor).join('');
}

function symbolic(value) {
    return [...value].map(digit => {
        const bits = Number(digit);
        return (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-');
    }).join('');
}

function refresh() {
    const value = octal();
    document.getElementById('octal').textContent = value;
    document.getElementById('symbolic').textContent = symbolic(value);
}

for (const checkbox of document.querySelectorAll('[data-bit]')) {
    checkbox.addEventListener('change', refresh);
}

document.getElementById('applyButton').addEventListener('click', () => {
    vscode.postMessage({
        command: 'applyPermissions',
        permissions: octal(),
        user: document.getElementById('userSelect').value,
        group: document.getElementById('groupSelect').value,
    });
});

document.getElementById('cancelButton').addEventListener('click', () => {
    vscode.postMessage({ command: 'cancelEdit' });
});`;

    return page('Edit Permissions', body, script);
}

/** Renders the panel's idle state. */
export function renderEmpty(): string {
    return page('File Details', '<div class="empty">Select a file or folder in Remote Files.</div>');
}

/**
 * Renders the totals for a selection of several entries.
 *
 * A single entry has details worth showing; several have a different question
 * behind them, which is how much has been picked.
 *
 * @param summary The selection's totals.
 * @returns The panel's HTML.
 */
export function renderSelection(summary: SelectionSummary): string {
    const rows = summary.names.map(name => `<li>${escapeHtml(name)}</li>`).join('');

    const body = `
        <h2>${summary.files + summary.folders} selected</h2>
        <p class="summary">${escapeHtml(describeSelection(summary, formatBytes))}</p>
        <ul class="selection">${rows}</ul>
    `;

    return page('File Details', body);
}

/**
 * Hosts the file details panel.
 *
 * A webview view is not resolved until it is revealed, so HTML shown before
 * that is held and applied when the view appears.
 */
export class FileDetailsViewProvider implements vscode.WebviewViewProvider {
    /** Must match the view id contributed in package.json. */
    public static readonly viewId = 'remoteFileDetailsView';

    private view?: vscode.WebviewView;
    private pendingHtml?: string;
    private messageHandler?: (message: any) => void;

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };

        // One listener for the life of the view, forwarding to whichever
        // provider rendered the panel last.
        webviewView.webview.onDidReceiveMessage(message => this.messageHandler?.(message));

        webviewView.webview.html = this.pendingHtml ?? renderEmpty();
        this.pendingHtml = undefined;
    }

    /**
     * Sets the handler for messages posted by the panel, replacing any previous one.
     *
     * @param handler Receives each message from the webview.
     */
    public setMessageHandler(handler: (message: any) => void): void {
        this.messageHandler = handler;
    }

    /**
     * Shows content in the panel.
     *
     * @param html The content to display.
     * @param reveal Whether to focus the panel. False for selection-driven
     *   updates, so the tree keeps keyboard focus.
     */
    public async show(html: string, reveal = true): Promise<void> {
        if (!this.view) {
            this.pendingHtml = html;
            if (reveal) {
                await vscode.commands.executeCommand(`${FileDetailsViewProvider.viewId}.focus`);
            }
            return;
        }

        this.pendingHtml = undefined;
        if (reveal) {
            this.view.show?.(true);
        }
        this.view.webview.html = html;
    }
}
