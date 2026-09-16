import * as assert from 'assert';
import {
    compareVersions,
    parseGalleryVersions,
    latestOn,
    isPreRelease,
    suggestChannel,
    describeSuggestion,
    GalleryVersion,
} from '../utils/releaseCheck';

/** Builds a gallery reply carrying these versions. */
function reply(versions: [string, boolean][]): unknown {
    return {
        results: [
            {
                extensions: [
                    {
                        versions: versions.map(([version, preRelease]) => ({
                            version,
                            properties: preRelease
                                ? [{ key: 'Microsoft.VisualStudio.Code.PreRelease', value: 'true' }]
                                : [{ key: 'Microsoft.VisualStudio.Code.Engine', value: '^1.96.0' }],
                        })),
                    },
                ],
            },
        ],
    };
}

const versions = (entries: [string, boolean][]): GalleryVersion[] =>
    entries.map(([version, preRelease]) => ({ version, preRelease }));

suite('releaseCheck: comparing versions', () => {
    test('orders by each part in turn', () => {
        assert.ok(compareVersions('0.0.10', '0.0.9') > 0);
        assert.ok(compareVersions('0.1.0', '0.0.99') > 0);
        assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
        assert.strictEqual(compareVersions('0.0.9', '0.0.9'), 0);
    });

    test('treats a missing part as zero, so 1.0 equals 1.0.0', () => {
        assert.strictEqual(compareVersions('1.0', '1.0.0'), 0);
        assert.ok(compareVersions('1.0.1', '1.0') > 0);
    });

    test('does not throw on something unparseable', () => {
        assert.strictEqual(compareVersions('', ''), 0);
        assert.ok(compareVersions('1.0.0', 'x.y.z') > 0);
    });
});

suite('releaseCheck: reading the gallery reply', () => {
    test('takes the versions and their channel', () => {
        assert.deepStrictEqual(
            parseGalleryVersions(
                reply([
                    ['0.1.0', false],
                    ['0.1.1', true],
                ])
            ),
            [
                { version: '0.1.0', preRelease: false },
                { version: '0.1.1', preRelease: true },
            ]
        );
    });

    test('stays quiet on a reply of the wrong shape rather than throwing', () => {
        assert.deepStrictEqual(parseGalleryVersions({}), []);
        assert.deepStrictEqual(parseGalleryVersions(null), []);
        assert.deepStrictEqual(parseGalleryVersions({ results: [] }), []);
        assert.deepStrictEqual(parseGalleryVersions({ results: [{ extensions: [{}] }] }), []);
    });

    test('skips an entry with no version string', () => {
        const payload = { results: [{ extensions: [{ versions: [{ properties: [] }, { version: '1.0.0' }] }] }] };

        assert.deepStrictEqual(parseGalleryVersions(payload), [{ version: '1.0.0', preRelease: false }]);
    });
});

suite('releaseCheck: the newest on a channel', () => {
    const listed = versions([
        ['0.0.9', true],
        ['0.1.0', false],
        ['0.1.1', true],
        ['0.0.8', false],
    ]);

    test('finds the newest release', () => {
        assert.strictEqual(latestOn(listed, false), '0.1.0');
    });

    test('finds the newest pre-release', () => {
        assert.strictEqual(latestOn(listed, true), '0.1.1');
    });

    test('reports nothing for an empty channel', () => {
        assert.strictEqual(latestOn(versions([['1.0.0', false]]), true), undefined);
    });
});

suite('releaseCheck: which channel is installed', () => {
    const listed = versions([
        ['0.0.9', true],
        ['0.0.8', false],
    ]);

    test('recognises a pre-release', () => {
        assert.ok(isPreRelease('0.0.9', listed));
    });

    test('recognises a release', () => {
        assert.ok(!isPreRelease('0.0.8', listed));
    });

    test('treats a version the gallery never listed as a release, which is quieter', () => {
        assert.ok(!isPreRelease('0.0.99', listed));
    });
});

suite('releaseCheck: what to suggest', () => {
    test('offers the release once the stable line has caught up', () => {
        const listed = versions([
            ['0.0.9', true],
            ['0.0.9', false],
        ]);

        assert.deepStrictEqual(suggestChannel('0.0.9', listed), { channel: 'release', version: '0.0.9' });
    });

    test('offers the release when the stable line has gone past', () => {
        const listed = versions([
            ['0.0.9', true],
            ['0.1.0', false],
        ]);

        assert.deepStrictEqual(suggestChannel('0.0.9', listed), { channel: 'release', version: '0.1.0' });
    });

    test('leaves a pre-release alone while it is still ahead', () => {
        const listed = versions([
            ['0.1.0', true],
            ['0.0.9', false],
        ]);

        assert.strictEqual(suggestChannel('0.1.0', listed), undefined);
    });

    test('offers a pre-release that is ahead of the installed release', () => {
        const listed = versions([
            ['0.0.9', false],
            ['0.1.0', true],
        ]);

        assert.deepStrictEqual(suggestChannel('0.0.9', listed), { channel: 'pre-release', version: '0.1.0' });
    });

    test('does not offer a pre-release that has fallen behind the release', () => {
        const listed = versions([
            ['0.1.0', false],
            ['0.0.9', true],
        ]);

        assert.strictEqual(suggestChannel('0.1.0', listed), undefined);
    });

    test('says nothing when the gallery listed nothing', () => {
        assert.strictEqual(suggestChannel('0.0.9', []), undefined);
    });
});

suite('releaseCheck: what the user is told', () => {
    test('says why leaving the pre-release is worth it', () => {
        const text = describeSuggestion({ channel: 'release', version: '0.1.0' }, '0.0.9');

        assert.ok(text.includes('pre-release'));
        assert.ok(text.includes('0.1.0'));
        assert.ok(text.includes('stable release'));
    });

    test('says the pre-release is ahead', () => {
        const text = describeSuggestion({ channel: 'pre-release', version: '0.1.0' }, '0.0.9');

        assert.ok(text.includes('0.1.0'));
        assert.ok(text.includes('ahead'));
    });
});
