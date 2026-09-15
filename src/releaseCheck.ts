/**
 * Asking the marketplace whether the other release channel is a better place
 * to be, and offering to move.
 *
 * Only the extension's own identifier leaves the machine, and only when the
 * user has left the check on. A failure -- no network, a proxy, a marketplace
 * that has changed shape -- leaves the check silent rather than complaining
 * about something the user did not ask for.
 */

import * as https from 'https';
import * as vscode from 'vscode';
import { ChannelSuggestion, describeSuggestion, parseGalleryVersions, suggestChannel } from './utils/releaseCheck';
import { suggestVersionChannel } from './utils/settings';

/** The gallery's query endpoint. */
const GALLERY = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery';

/** IncludeVersions | IncludeVersionProperties, which is all this needs. */
const FLAGS = 0x1 | 0x10;

/** Long enough for a slow network, short enough not to hang activation. */
const TIMEOUT_MS = 8000;

/** How long to wait before asking again. */
const INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Where the last check, and any refusal, are remembered. */
const LAST_CHECK_KEY = 'releaseCheck.lastCheck';
const DECLINED_KEY = 'releaseCheck.declinedVersion';

/**
 * Checks the marketplace and offers the other channel when it is worth it.
 *
 * Runs at most once a day, and never blocks anything: it is started without
 * being awaited and gives up quietly on any failure.
 *
 * @param context The extension context, for its version and its state.
 */
export async function checkReleaseChannel(context: vscode.ExtensionContext): Promise<void> {
    if (!suggestVersionChannel()) {
        return;
    }

    const lastCheck = context.globalState.get<number>(LAST_CHECK_KEY, 0);
    if (Date.now() - lastCheck < INTERVAL_MS) {
        return;
    }

    const installed: string = context.extension.packageJSON?.version;
    if (typeof installed !== 'string') {
        return;
    }

    try {
        const versions = parseGalleryVersions(await queryGallery(context.extension.id));
        await context.globalState.update(LAST_CHECK_KEY, Date.now());

        const suggestion = suggestChannel(installed, versions);
        if (!suggestion) {
            return;
        }

        // A version already turned down is not offered again.
        if (context.globalState.get<string>(DECLINED_KEY) === suggestion.version) {
            return;
        }

        await offer(context, suggestion, installed);
    } catch (error) {
        console.log('Release channel check skipped:', error instanceof Error ? error.message : error);
    }
}

/**
 * Puts the suggestion to the user and acts on the answer.
 *
 * @param context The extension context, for remembering a refusal.
 * @param suggestion What is on offer.
 * @param installed The running version.
 */
async function offer(
    context: vscode.ExtensionContext,
    suggestion: ChannelSuggestion,
    installed: string
): Promise<void> {
    const switchTo = suggestion.channel === 'release' ? 'Switch to release' : 'Try the pre-release';

    const answer = await vscode.window.showInformationMessage(
        describeSuggestion(suggestion, installed),
        switchTo,
        'Not now',
        'Stop asking'
    );

    if (answer === 'Stop asking') {
        await vscode.workspace
            .getConfiguration('sshMultiConnect')
            .update('suggestVersionChannel', false, vscode.ConfigurationTarget.Global);
        return;
    }

    if (answer !== switchTo) {
        // Only this version is declined; a later one may still be worth asking about.
        await context.globalState.update(DECLINED_KEY, suggestion.version);
        return;
    }

    await switchChannel(context.extension.id, suggestion.channel === 'pre-release');
}

/**
 * Installs the extension from the other channel.
 *
 * There is no command for switching channels -- the buttons in the Extensions
 * view are not exposed -- but installExtension takes the channel as an option,
 * which amounts to the same thing.
 *
 * @param extensionId The extension to reinstall.
 * @param preRelease Which channel to take it from.
 */
async function switchChannel(extensionId: string, preRelease: boolean): Promise<void> {
    try {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', extensionId, {
            installPreReleaseVersion: preRelease,
        });
    } catch (error) {
        vscode.window.showErrorMessage(
            `Could not switch version: ${error instanceof Error ? error.message : String(error)}. ` +
                "The Extensions view can do it from the extension's own page."
        );
    }
}

/**
 * Asks the gallery which versions of an extension exist.
 *
 * @param extensionId The extension to ask about.
 * @returns The parsed reply.
 */
function queryGallery(extensionId: string): Promise<unknown> {
    const body = JSON.stringify({
        filters: [{ criteria: [{ filterType: 7, value: extensionId }], pageNumber: 1, pageSize: 1 }],
        flags: FLAGS,
    });

    return new Promise((resolve, reject) => {
        const request = https.request(
            GALLERY,
            {
                method: 'POST',
                headers: {
                    Accept: 'application/json;api-version=3.0-preview.1',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: TIMEOUT_MS,
            },
            response => {
                if (response.statusCode !== 200) {
                    response.resume();
                    reject(new Error(`marketplace returned ${response.statusCode}`));
                    return;
                }

                let text = '';
                response.setEncoding('utf-8');
                response.on('data', chunk => (text += chunk));
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(text));
                    } catch (error) {
                        reject(error);
                    }
                });
            }
        );

        request.on('timeout', () => request.destroy(new Error('marketplace timed out')));
        request.on('error', reject);
        request.end(body);
    });
}
