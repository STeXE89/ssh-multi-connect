import * as assert from 'assert';
import * as vscode from 'vscode';
import { SSHViewProvider, SSHConnectionTreeItem, ExtendedSSHConnection } from '../sshConnection';
import { SSHTunnelTreeItem } from '../tunnelUi';
import { TunnelManager } from '../tunnels';
import { TunnelConfig, LOOPBACK } from '../utils/tunnelModel';

/** Builds a provider whose connection list is fixed, ignoring ~/.ssh/config. */
function providerWith(connections: ExtendedSSHConnection[]): SSHViewProvider {
    const provider = new SSHViewProvider({} as vscode.ExtensionContext);
    provider.connections = connections;
    return provider;
}

function connection(overrides: Partial<ExtendedSSHConnection> = {}): ExtendedSSHConnection {
    return { id: 'web', host: 'web', hostname: '10.0.0.5', user: 'me', ...overrides };
}

function config(overrides: Partial<TunnelConfig> = {}): TunnelConfig {
    return {
        id: 't1',
        kind: 'local',
        bindAddress: LOOPBACK,
        listenPort: 18080,
        destinationHost: 'db',
        destinationPort: 5432,
        ...overrides,
    };
}

suite('tunnels: showing up in the connections tree', () => {
    test('a connection with no tunnels is not expandable', async () => {
        const provider = providerWith([connection()]);
        provider.setTunnelManager(new TunnelManager(() => undefined));

        const [item] = (await provider.getChildren()) as SSHConnectionTreeItem[];

        assert.strictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
    });

    test('a connection with a tunnel becomes expandable', async () => {
        // If this stays None, VS Code never asks for children and the tunnel
        // is invisible however well the forward itself works.
        const manager = new TunnelManager(() => undefined);
        const provider = providerWith([connection()]);
        provider.setTunnelManager(manager);
        await manager.add('web', config());

        const [item] = (await provider.getChildren()) as SSHConnectionTreeItem[];

        assert.notStrictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
        manager.dispose();
    });

    test('the tunnel is returned as a child of its connection', async () => {
        const manager = new TunnelManager(() => undefined);
        const provider = providerWith([connection()]);
        provider.setTunnelManager(manager);
        await manager.add('web', config());

        const [item] = (await provider.getChildren()) as SSHConnectionTreeItem[];
        const children = await provider.getChildren(item);

        assert.strictEqual(children.length, 1);
        assert.ok(children[0] instanceof SSHTunnelTreeItem);
        assert.match(String(children[0].label), /18080/);
        manager.dispose();
    });

    test('tunnels are kept with the right connection', async () => {
        const manager = new TunnelManager(() => undefined);
        const provider = providerWith([connection({ id: 'web', host: 'web' }), connection({ id: 'db', host: 'db' })]);
        provider.setTunnelManager(manager);
        await manager.add('web', config());

        const items = (await provider.getChildren()) as SSHConnectionTreeItem[];
        const web = items.find(item => item.connection.id === 'web')!;
        const db = items.find(item => item.connection.id === 'db')!;

        assert.strictEqual((await provider.getChildren(web)).length, 1);
        assert.strictEqual((await provider.getChildren(db)).length, 0);
        manager.dispose();
    });

    test('a connection inside a folder still shows its tunnels', async () => {
        const manager = new TunnelManager(() => undefined);
        const provider = providerWith([connection({ vFolderTag: 'Prod' })]);
        provider.setTunnelManager(manager);
        await manager.add('web', config());

        const [folder] = await provider.getChildren();
        const [item] = (await provider.getChildren(folder)) as SSHConnectionTreeItem[];

        assert.notStrictEqual(item.collapsibleState, vscode.TreeItemCollapsibleState.None);
        assert.strictEqual((await provider.getChildren(item)).length, 1);
        manager.dispose();
    });

    test('tree items carry stable ids so expansion survives a refresh', async () => {
        // Without an id VS Code identifies elements by object, and every
        // refresh builds new ones, so an expanded connection collapses again
        // and the tunnel appears to vanish.
        const manager = new TunnelManager(() => undefined);
        const provider = providerWith([connection()]);
        provider.setTunnelManager(manager);
        await manager.add('web', config());

        const [first] = (await provider.getChildren()) as SSHConnectionTreeItem[];
        const [second] = (await provider.getChildren()) as SSHConnectionTreeItem[];

        assert.ok(first.id, 'connection items need a stable id');
        assert.strictEqual(first.id, second.id);
        manager.dispose();
    });
});
