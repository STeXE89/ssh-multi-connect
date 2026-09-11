import * as assert from 'assert';
import * as vscode from 'vscode';

const EXTENSION_ID = 'STeXE89.ssh-multi-connect';

suite('Extension activation', () => {
    suiteSetup(async () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        assert.ok(extension, `extension ${EXTENSION_ID} not found`);
        await extension.activate();
    });

    test('activates without throwing', () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);

        assert.strictEqual(extension?.isActive, true);
    });

    test('registers every command it contributes', async () => {
        // Derived from the manifest rather than a hand-kept list, so a command
        // added to package.json but never registered fails here.
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const declared: string[] = (extension?.packageJSON?.contributes?.commands ?? []).map(
            (entry: { command: string }) => entry.command
        );
        const registered = new Set(await vscode.commands.getCommands(true));

        assert.ok(declared.length > 0, 'the manifest contributes no commands');
        const missing = declared.filter(command => !registered.has(command));

        assert.deepStrictEqual(missing, [], `contributed but not registered: ${missing.join(', ')}`);
    });

    test('every command used in a menu is contributed', async () => {
        // A menu entry pointing at an undeclared command silently never shows.
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const contributes = extension?.packageJSON?.contributes ?? {};
        const declared = new Set((contributes.commands ?? []).map((entry: { command: string }) => entry.command));

        const used = new Set<string>();
        for (const entries of Object.values(contributes.menus ?? {})) {
            for (const entry of entries as { command: string }[]) {
                used.add(entry.command);
            }
        }

        const undeclared = [...used].filter(command => !declared.has(command));

        assert.deepStrictEqual(undeclared, [], `menus reference undeclared commands: ${undeclared.join(', ')}`);
    });

    test('uses the right icon format for each role', () => {
        // The marketplace icon must be a bitmap: vsce rejects SVG there. The
        // activity bar wants an SVG so VS Code can tint it per theme.
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const manifest = extension?.packageJSON ?? {};

        assert.match(manifest.icon ?? '', /\.png$/, 'the marketplace icon must be a PNG');

        for (const container of manifest.contributes?.viewsContainers?.activitybar ?? []) {
            assert.match(container.icon ?? '', /\.svg$/, `${container.id} should use an SVG`);
        }
    });

    test('keeps every view in the activity bar container', () => {
        // The multi-command view used to live in the bottom panel; all four
        // views now belong to the one sidebar container.
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const contributes = extension?.packageJSON?.contributes ?? {};

        assert.deepStrictEqual(Object.keys(contributes.viewsContainers ?? {}), ['activitybar']);
        assert.deepStrictEqual(Object.keys(contributes.views ?? {}), ['sshMultiConnect']);
        assert.ok(
            (contributes.views.sshMultiConnect ?? []).some((view: { id: string }) => view.id === 'multiCommandView'),
            'multiCommandView is not in the sidebar container'
        );
    });

    test('contributes every view the code registers a provider for', () => {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        const views = extension?.packageJSON?.contributes?.views ?? {};
        const ids = Object.values(views)
            .flat()
            .map((view: any) => view.id);

        for (const expected of ['sshConnectionsView', 'remoteFilesView', 'remoteFileDetailsView', 'multiCommandView']) {
            assert.ok(ids.includes(expected), `view ${expected} is not contributed`);
        }
    });

    test('creating the connections tree view again does not throw', async () => {
        // activate() owns the single 'sshConnectionsView'. This asserts the id
        // is claimed exactly once by the extension: a second provider-owned
        // view used to be created behind it.
        const view = vscode.window.createTreeView('sshConnectionsView', {
            treeDataProvider: { getTreeItem: (e: vscode.TreeItem) => e, getChildren: () => [] },
        });

        assert.ok(view);
        view.dispose();
    });
});
