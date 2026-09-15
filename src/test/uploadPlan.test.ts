import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planUpload, describeSkipped } from '../utils/uploadPlan';

/** Builds a throwaway local tree and removes it afterwards. */
async function withTree(build: (root: string) => Promise<void>, body: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ssh-multi-connect-'));
    try {
        await build(root);
        await body(root);
    } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
    }
}

suite('planUpload', () => {
    test('plans a single file', async () => {
        await withTree(
            async root => fs.promises.writeFile(path.join(root, 'a.txt'), 'hello'),
            async root => {
                const plan = await planUpload([path.join(root, 'a.txt')], '/srv');

                assert.deepStrictEqual(
                    plan.steps.map(step => [step.kind, step.remotePath, step.size]),
                    [['file', '/srv/a.txt', 5]]
                );
                assert.deepStrictEqual(plan.skipped, []);
            }
        );
    });

    test('creates a folder before the files inside it', async () => {
        await withTree(
            async root => {
                await fs.promises.mkdir(path.join(root, 'site/css'), { recursive: true });
                await fs.promises.writeFile(path.join(root, 'site/index.html'), '<html>');
                await fs.promises.writeFile(path.join(root, 'site/css/main.css'), 'body{}');
            },
            async root => {
                const plan = await planUpload([path.join(root, 'site')], '/srv');

                assert.deepStrictEqual(
                    plan.steps.map(step => `${step.kind} ${step.remotePath}`),
                    [
                        'directory /srv/site',
                        'directory /srv/site/css',
                        'file /srv/site/css/main.css',
                        'file /srv/site/index.html',
                    ]
                );
            }
        );
    });

    test('skips a symbolic link rather than following it', async () => {
        await withTree(
            async root => {
                await fs.promises.mkdir(path.join(root, 'real'));
                await fs.promises.writeFile(path.join(root, 'real/a.txt'), 'x');
                // A link back to its own parent would recurse forever.
                await fs.promises.symlink(root, path.join(root, 'real/loop'));
            },
            async root => {
                const plan = await planUpload([path.join(root, 'real')], '/srv');

                assert.deepStrictEqual(
                    plan.steps.map(step => step.kind),
                    ['directory', 'file']
                );
                assert.deepStrictEqual(plan.skipped, [{ name: 'loop', reason: 'symbolic link' }]);
            }
        );
    });

    test('reports a path that has gone away instead of failing the drop', async () => {
        const plan = await planUpload(['/definitely/not/here.txt'], '/srv');

        assert.deepStrictEqual(plan.steps, []);
        assert.strictEqual(plan.skipped.length, 1);
        assert.strictEqual(plan.skipped[0].name, 'here.txt');
    });

    test('keeps several dropped paths in the order they arrived', async () => {
        await withTree(
            async root => {
                await fs.promises.writeFile(path.join(root, 'b.txt'), 'b');
                await fs.promises.writeFile(path.join(root, 'a.txt'), 'a');
            },
            async root => {
                const plan = await planUpload([path.join(root, 'b.txt'), path.join(root, 'a.txt')], '/srv');

                assert.deepStrictEqual(
                    plan.steps.map(step => step.remotePath),
                    ['/srv/b.txt', '/srv/a.txt']
                );
            }
        );
    });
});

suite('describeSkipped', () => {
    test('says nothing when everything went', () => {
        assert.strictEqual(describeSkipped({ steps: [], skipped: [] }), undefined);
    });

    test('names what was left out and why', () => {
        const skipped = [
            { name: 'loop', reason: 'symbolic link' },
            { name: 'pipe', reason: 'not a regular file' },
        ];

        assert.strictEqual(describeSkipped({ steps: [], skipped }), 'loop (symbolic link), pipe (not a regular file)');
    });
});
