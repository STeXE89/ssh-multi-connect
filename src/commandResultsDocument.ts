/**
 * Shows a multi-host command run as a read-only editor document.
 *
 * An editor rather than a webview: the report is plain text, so it can be
 * searched, copied, and diffed against the next run with the tools the editor
 * already has.
 */

import * as vscode from 'vscode';

/** The scheme these documents are served under. */
export const RESULTS_SCHEME = 'ssh-multi-connect-results';

/**
 * Builds the name shown on the editor tab.
 *
 * The command itself is the useful part of the name, shortened so a long
 * pipeline does not push every other tab off the screen.
 *
 * @param command The command that was run.
 * @returns A tab name.
 */
export function resultsDocumentName(command: string): string {
    const oneLine = command.replace(/\s+/g, ' ').trim();
    const shortened = oneLine.length > 40 ? `${oneLine.slice(0, 39)}...` : oneLine;
    // The path is a URI, so the separators have to go.
    return `${shortened.replace(/[/\\]/g, '-') || 'command'}.log`;
}

/** Serves the reports of past runs. */
export class CommandResultsDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
    private readonly reports = new Map<string, string>();
    private readonly changed = new vscode.EventEmitter<vscode.Uri>();
    private runs = 0;

    readonly onDidChange = this.changed.event;

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.reports.get(uri.toString()) ?? '';
    }

    /**
     * Opens a report in an editor.
     *
     * @param command The command that was run.
     * @param report The rendered report.
     */
    async show(command: string, report: string): Promise<void> {
        // Each run gets its own URI, so an earlier report stays open.
        const uri = vscode.Uri.from({
            scheme: RESULTS_SCHEME,
            path: `/${resultsDocumentName(command)}`,
            query: String(++this.runs),
        });

        this.reports.set(uri.toString(), report);
        this.changed.fire(uri);

        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
    }

    dispose(): void {
        this.changed.dispose();
        this.reports.clear();
    }
}
