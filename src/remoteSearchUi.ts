/**
 * Searching a host's files, and opening what was found.
 *
 * The search runs on the host: `grep` there is faster than anything that
 * involves moving files here first, and it is the only way to search a tree
 * this machine has never seen.
 */

import * as vscode from 'vscode';
import { ExtendedSSHConnection } from './sshConnection';
import { RemoteFileProvider } from './remoteFile';
import { runOnHost } from './multiCommandRun';
import { buildSearchCommand, describeHit, parseSearchOutput, SearchHit } from './utils/remoteSearch';
import { log } from './log';

/** How many matches to bring back; beyond this the picker stops being useful. */
const LIMIT = 200;

/** A hit offered in the picker. */
interface HitPick extends vscode.QuickPickItem {
    hit: SearchHit;
}

/**
 * Asks what to look for, searches the host, and opens what is chosen.
 *
 * @param connection The host to search.
 * @param directory The folder to search under.
 */
export async function searchRemote(connection: ExtendedSSHConnection, directory: string): Promise<void> {
    if (!connection.client) {
        vscode.window.showErrorMessage(`Connect to ${connection.host} before searching.`);
        return;
    }

    const pattern = await vscode.window.showInputBox({
        title: `Search ${connection.host}:${directory}`,
        placeHolder: 'Text to find',
        prompt: 'Plain text, case-insensitive. Searched on the host itself.',
    });

    if (!pattern?.trim()) {
        return;
    }

    const command = buildSearchCommand({
        pattern,
        directory,
        ignoreCase: true,
        regex: false,
        limit: LIMIT,
    });

    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Searching ${connection.host}` },
        () => runOnHost({ host: connection.host, client: connection.client! }, command)
    );

    if (result.error) {
        vscode.window.showErrorMessage(`Search failed on ${connection.host}: ${result.error}`);
        return;
    }

    const hits = parseSearchOutput(result.stdout);
    log.info(`Search for "${pattern}" under ${directory} on ${connection.host}: ${hits.length} hit(s).`);

    if (hits.length === 0) {
        // grep exits 1 when it matched nothing, which is not a failure.
        vscode.window.showInformationMessage(`Nothing matching "${pattern}" under ${directory}.`);
        return;
    }

    await offerHits(connection, directory, pattern, hits);
}

/**
 * Shows the matches and opens the one chosen.
 *
 * @param connection The host searched.
 * @param directory The folder searched.
 * @param pattern What was searched for.
 * @param hits The matches.
 */
async function offerHits(
    connection: ExtendedSSHConnection,
    directory: string,
    pattern: string,
    hits: SearchHit[]
): Promise<void> {
    const picks: HitPick[] = hits.map(hit => ({ ...describeHit(hit, directory), hit }));

    const picked = await vscode.window.showQuickPick(picks, {
        title: `${hits.length}${hits.length === LIMIT ? '+' : ''} matches for "${pattern}"`,
        placeHolder: 'Open a match',
        matchOnDescription: true,
        matchOnDetail: true,
    });

    if (!picked) {
        return;
    }

    const provider = RemoteFileProvider.getProviderByConnectionId(connection.id);
    if (!provider) {
        vscode.window.showErrorMessage('Open the connection before opening a match.');
        return;
    }

    await provider.openRemoteFile(
        vscode.Uri.parse(`ssh://${connection.user}@${connection.hostname}:${connection.port ?? 22}${picked.hit.path}`),
        picked.hit.line
    );
}
