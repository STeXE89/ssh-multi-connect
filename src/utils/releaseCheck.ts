/**
 * Working out whether the other release channel has something better on offer.
 *
 * A pre-release is worth leaving once the stable line has caught up with it,
 * and worth trying when it has run ahead. Neither is something VS Code tells
 * an extension: it knows nothing about its own channel, so the answer is
 * derived from the version it is running and the versions the marketplace
 * lists.
 *
 * Pure: the gallery's reply comes in as parsed JSON and a suggestion goes out.
 */

/** One version as the marketplace lists it. */
export interface GalleryVersion {
    version: string;
    preRelease: boolean;
}

/** What to offer the user, when anything is worth offering. */
export interface ChannelSuggestion {
    /** The channel being suggested. */
    channel: 'release' | 'pre-release';
    /** The version that would be installed. */
    version: string;
}

/** The marketplace property that marks a pre-release build. */
const PRE_RELEASE_PROPERTY = 'Microsoft.VisualStudio.Code.PreRelease';

/**
 * Compares two dotted version strings.
 *
 * Only the numeric parts are compared, which is all an extension version has;
 * anything unparseable sorts as zero rather than throwing.
 *
 * @param a One version.
 * @param b The other.
 * @returns Negative when a is older, positive when newer, zero when equal.
 */
export function compareVersions(a: string, b: string): number {
    const parts = (value: string) => value.split('.').map(part => Number.parseInt(part, 10) || 0);
    const left = parts(a);
    const right = parts(b);

    for (let index = 0; index < Math.max(left.length, right.length); index++) {
        const difference = (left[index] ?? 0) - (right[index] ?? 0);
        if (difference !== 0) {
            return difference;
        }
    }

    return 0;
}

/**
 * Reads the version list out of a gallery `extensionquery` reply.
 *
 * The shape is defended against rather than trusted: this is a reply from a
 * service, and a missing field should leave the check quiet, not throw.
 *
 * @param payload The parsed JSON body.
 * @returns Every version listed, newest first as the gallery returns them.
 */
export function parseGalleryVersions(payload: unknown): GalleryVersion[] {
    const extensions = (payload as { results?: { extensions?: unknown[] }[] })?.results?.[0]?.extensions;
    const versions = (extensions?.[0] as { versions?: unknown[] })?.versions;

    if (!Array.isArray(versions)) {
        return [];
    }

    return versions
        .map(entry => {
            const version = (entry as { version?: unknown })?.version;
            if (typeof version !== 'string') {
                return undefined;
            }

            const properties = (entry as { properties?: { key?: string; value?: string }[] })?.properties ?? [];
            const preRelease = properties.some(
                property => property?.key === PRE_RELEASE_PROPERTY && property?.value === 'true'
            );

            return { version, preRelease };
        })
        .filter((entry): entry is GalleryVersion => entry !== undefined);
}

/**
 * The newest version on one channel.
 *
 * @param versions Every version the gallery listed.
 * @param preRelease Which channel to look at.
 * @returns The newest version there, or undefined when the channel is empty.
 */
export function latestOn(versions: GalleryVersion[], preRelease: boolean): string | undefined {
    return versions
        .filter(entry => entry.preRelease === preRelease)
        .map(entry => entry.version)
        .sort(compareVersions)
        .pop();
}

/**
 * Reports which channel the installed version came from.
 *
 * VS Code does not tell an extension, so it is decided by which list the
 * running version appears in. A version the gallery does not list at all --
 * a local build, or one pulled from a `.vsix` -- counts as a release, which
 * is the quieter assumption.
 *
 * @param installed The running version.
 * @param versions Every version the gallery listed.
 * @returns True when the running version is a pre-release.
 */
export function isPreRelease(installed: string, versions: GalleryVersion[]): boolean {
    return versions.some(entry => entry.version === installed && entry.preRelease);
}

/**
 * Decides what, if anything, to suggest.
 *
 * Leaving a pre-release is suggested once the stable line has reached the same
 * version, since from there the pre-release offers nothing the release does
 * not. Trying one is suggested only when it is genuinely ahead.
 *
 * @param installed The running version.
 * @param versions Every version the gallery listed.
 * @returns The suggestion, or undefined when the current channel is the right
 * place to be.
 */
export function suggestChannel(installed: string, versions: GalleryVersion[]): ChannelSuggestion | undefined {
    if (versions.length === 0) {
        return undefined;
    }

    const release = latestOn(versions, false);
    const preRelease = latestOn(versions, true);

    if (isPreRelease(installed, versions)) {
        return release && compareVersions(release, installed) >= 0
            ? { channel: 'release', version: release }
            : undefined;
    }

    return preRelease && compareVersions(preRelease, installed) > 0
        ? { channel: 'pre-release', version: preRelease }
        : undefined;
}

/**
 * Describes a suggestion, for the notification.
 *
 * @param suggestion What is being suggested.
 * @param installed The running version.
 * @returns A sentence saying what is on offer and why.
 */
export function describeSuggestion(suggestion: ChannelSuggestion, installed: string): string {
    return suggestion.channel === 'release'
        ? `SSH Multi Connect ${installed} is a pre-release, and ${suggestion.version} is now out as a stable release. Switch to it?`
        : `SSH Multi Connect ${suggestion.version} is available as a pre-release, ahead of the ${installed} you are on. Try it?`;
}
