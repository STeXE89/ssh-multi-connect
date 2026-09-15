/**
 * The "run this on several hosts and show me what they said" flow.
 *
 * The multi-command panel types a command into each host's terminal, which is
 * right for anything interactive but leaves the answers scattered across
 * terminals. This runs the command on its own channel instead and collects the
 * output into one report.
 */

import * as vscode from 'vscode';
import { CommandResultsDocuments } from './commandResultsDocument';
import { CommandTarget, runOnHosts } from './multiCommandRun';
import { CommandResult, renderReport, succeeded } from './utils/commandResults';

/** A host offered in the picker. */
interface HostPick extends vscode.QuickPickItem {
    target: CommandTarget;
}

/**
 * Asks which hosts and what command, runs it, and opens the report.
 *
 * @param targets The hosts that are currently connected.
 * @param documents Where the report is shown.
 */
export async function runCommandOnHosts(targets: CommandTarget[], documents: CommandResultsDocuments): Promise<void> {
    if (targets.length === 0) {
        vscode.window.showInformationMessage('Connect to at least one host first.');
        return;
    }

    const picks = await vscode.window.showQuickPick<HostPick>(
        targets.map(target => ({ label: target.host, picked: true, target })),
        { canPickMany: true, placeHolder: 'Run on which hosts?' }
    );

    if (!picks || picks.length === 0) {
        return;
    }

    const command = await vscode.window.showInputBox({
        placeHolder: 'Command to run on every selected host',
        prompt: `Runs on ${picks.length} host(s), without a terminal`,
    });

    if (!command?.trim()) {
        return;
    }

    const results = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Running on ${picks.length} host(s)`,
            cancellable: false,
        },
        async progress => {
            let done = 0;
            return runOnHosts(
                picks.map(pick => pick.target),
                command,
                result => progress.report({ message: `${++done}/${picks.length} ${result.host}` })
            );
        }
    );

    await documents.show(command, renderReport(command, results));
    reportFailures(results);
}

/**
 * Says how many hosts did not succeed, when any did not.
 *
 * @param results The run's results.
 */
function reportFailures(results: CommandResult[]): void {
    const failed = results.filter(result => !succeeded(result));
    if (failed.length > 0) {
        vscode.window.showWarningMessage(
            `${failed.length} of ${results.length} host(s) did not succeed: ${failed.map(r => r.host).join(', ')}.`
        );
    }
}
