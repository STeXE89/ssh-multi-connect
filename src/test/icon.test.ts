import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.join(__dirname, '..', '..');
const RESOURCES = path.join(REPO_ROOT, 'resources');

/** SVG files shipped with the extension. */
function svgFiles(): string[] {
    return fs
        .readdirSync(RESOURCES)
        .filter(name => name.endsWith('.svg'))
        .map(name => path.join(RESOURCES, name));
}

/**
 * Checks the parts of XML well-formedness that actually break these files.
 *
 * There is no XML parser in the extension host, and the failure that shipped
 * was a comment containing `--`, which is illegal and makes the whole document
 * unparseable while still looking fine to the eye.
 */
function xmlProblems(source: string): string[] {
    const problems: string[] = [];

    for (const [, body] of source.matchAll(/<!--([\s\S]*?)-->/g)) {
        if (body.includes('--')) {
            problems.push(`comment contains "--": ${body.trim().slice(0, 60)}`);
        }
    }
    if ((source.match(/<!--/g) ?? []).length !== (source.match(/-->/g) ?? []).length) {
        problems.push('unbalanced comment delimiters');
    }

    const withoutComments = source.replace(/<!--[\s\S]*?-->/g, '');
    const stack: string[] = [];
    for (const [tag, closing, name, selfClosing] of withoutComments.matchAll(
        /<(\/)?([A-Za-z][\w:-]*)[^>]*?(\/)?>/g
    ) as Iterable<RegExpMatchArray>) {
        void tag;
        if (selfClosing) {
            continue;
        }
        if (closing) {
            if (stack.pop() !== name) {
                problems.push(`unexpected closing tag </${name}>`);
            }
        } else {
            stack.push(name);
        }
    }
    if (stack.length) {
        problems.push(`unclosed tags: ${stack.join(', ')}`);
    }

    return problems;
}

/** Reads width and height out of a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
    const header = fs.readFileSync(file).subarray(0, 24);
    assert.strictEqual(header.subarray(1, 4).toString(), 'PNG', `${file} is not a PNG`);
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

suite('marketplace icon', () => {
    test('is a square PNG of at least 128px', () => {
        // The publishing guidance asks for a 128x128 PNG, and vsce rejects SVG
        // in this slot outright.
        const { width, height } = pngSize(path.join(RESOURCES, 'icon.png'));

        assert.strictEqual(width, height, 'the icon must be square');
        assert.ok(width >= 128, `the icon is ${width}px, the guidance is 128`);
    });

    test('is the file the manifest points at', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));

        assert.strictEqual(manifest.icon, 'resources/icon.png');
        assert.ok(fs.existsSync(path.join(REPO_ROOT, manifest.icon)));
    });
});

suite('shipped SVG assets', () => {
    test('there is at least one', () => {
        assert.ok(svgFiles().length > 0, 'no SVG found in resources/');
    });

    test('each one is well-formed', () => {
        for (const file of svgFiles()) {
            const problems = xmlProblems(fs.readFileSync(file, 'utf-8'));
            assert.deepStrictEqual(problems, [], `${path.basename(file)}: ${problems.join('; ')}`);
        }
    });

    test('each one is an svg root with a viewBox', () => {
        for (const file of svgFiles()) {
            const source = fs.readFileSync(file, 'utf-8');
            assert.match(source, /<svg[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/, path.basename(file));
            assert.match(source, /<svg[^>]*\sviewBox="[\d.\s-]+"/, path.basename(file));
        }
    });

    test('every referenced id is defined in the same file', () => {
        // A clip-path pointing at a missing id renders as nothing at all.
        for (const file of svgFiles()) {
            const source = fs.readFileSync(file, 'utf-8');
            const defined = new Set([...source.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
            for (const [, referenced] of source.matchAll(/url\(#([^)]+)\)/g)) {
                assert.ok(defined.has(referenced), `${path.basename(file)}: no id "${referenced}"`);
            }
        }
    });

    test('the activity bar icon draws a single shape', () => {
        // Separate <path> elements are each filled independently, which is how
        // the terminal prompt was lost: its subpath was painted instead of
        // being cut out of the tile.
        const source = fs.readFileSync(path.join(RESOURCES, 'icon.svg'), 'utf-8');
        const paths = source.match(/<path\b/g) ?? [];

        assert.strictEqual(paths.length, 1, 'the icon must be one path so even-odd cuts holes');
        assert.match(source, /fill-rule="evenodd"/);
    });
});
