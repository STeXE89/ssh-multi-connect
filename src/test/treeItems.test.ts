import * as assert from 'assert';
import {
    SSHConnectionTreeItem,
    SSHFolderTreeItem,
    describeTarget,
    connectionTooltip,
    activeConnectionBadge,
    connectionPicks,
    ExtendedSSHConnection,
} from '../sshConnection';

function connection(overrides: Partial<ExtendedSSHConnection> = {}): ExtendedSSHConnection {
    return { id: 'web', host: 'web', hostname: '10.0.0.5', ...overrides };
}

suite('connection tree item: label and description', () => {
    test('labels the item with the ssh_config alias', () => {
        const item = new SSHConnectionTreeItem(connection({ host: 'web', user: 'deploy' }), false);

        assert.strictEqual(item.label, 'web');
    });

    test('describes the target separately from the label', () => {
        // The label and description used to both read `user@host`, so the
        // same text appeared twice on every row.
        const item = new SSHConnectionTreeItem(
            connection({ host: 'web', hostname: '10.0.0.5', user: 'deploy' }),
            false
        );

        assert.strictEqual(item.label, 'web');
        assert.strictEqual(item.description, 'deploy@10.0.0.5');
        assert.notStrictEqual(item.label, item.description);
    });

    test('omits the description when it would repeat the label', () => {
        // `Host example.com` with no User and no distinct HostName.
        const item = new SSHConnectionTreeItem(
            connection({ host: 'example.com', hostname: 'example.com', user: undefined }),
            false
        );

        assert.strictEqual(item.description, undefined);
    });

    test('shows the hostname alone when no user is configured', () => {
        assert.strictEqual(describeTarget(connection({ host: 'web', hostname: '10.0.0.5' })), '10.0.0.5');
    });

    test('falls back to a placeholder when the host is missing', () => {
        assert.strictEqual(new SSHConnectionTreeItem(connection({ host: '' }), false).label, 'Unknown Host');
    });
});

suite('connection tree item: tooltip', () => {
    test('lists the settings that matter', () => {
        const tooltip = connectionTooltip(
            connection({
                host: 'web',
                hostname: '10.0.0.5',
                user: 'deploy',
                port: 2222,
                identityFile: '/home/me/.ssh/web_key',
                vFolderTag: 'Prod/EU',
            })
        );

        assert.match(tooltip, /Host: web/);
        assert.match(tooltip, /HostName: 10\.0\.0\.5/);
        assert.match(tooltip, /User: deploy/);
        assert.match(tooltip, /Port: 2222/);
        assert.match(tooltip, /IdentityFile: \/home\/me\/\.ssh\/web_key/);
        assert.match(tooltip, /Folder: Prod\/EU/);
    });

    test('shows the default port when none is set', () => {
        assert.match(connectionTooltip(connection()), /Port: 22/);
    });

    test('omits lines that have no value', () => {
        const tooltip = connectionTooltip(connection({ user: undefined }));

        assert.ok(!tooltip.includes('User:'));
        assert.ok(!tooltip.includes('IdentityFile:'));
        assert.ok(!tooltip.includes('Folder:'));
    });
});

suite('connection tree item: state', () => {
    test('marks a connected item so its inline actions differ', () => {
        assert.strictEqual(new SSHConnectionTreeItem(connection(), true).contextValue, 'sshConnectionConnected');
        assert.strictEqual(new SSHConnectionTreeItem(connection(), false).contextValue, 'sshConnectionDisconnected');
    });

    test('carries a decoration URI so the label can be coloured', () => {
        const item = new SSHConnectionTreeItem(connection({ id: 'web' }), true);

        assert.strictEqual(item.resourceUri?.scheme, 'ssh-connection');
        assert.strictEqual(item.resourceUri?.path, '/web');
    });
});

suite('folder tree item', () => {
    test('labels the item with the last path segment only', () => {
        assert.strictEqual(new SSHFolderTreeItem('Prod/EU').label, 'EU');
    });

    test('keeps the count out of the label and description', () => {
        // The count is a decoration badge; as description text it read as part
        // of the folder name.
        const item = new SSHFolderTreeItem('Prod', 3);

        assert.strictEqual(item.label, 'Prod');
        assert.strictEqual(item.description, undefined);
    });

    test('puts the full path and the count in the tooltip', () => {
        assert.strictEqual(new SSHFolderTreeItem('Prod/EU', 3).tooltip, 'Prod/EU — 3 connections');
        assert.strictEqual(new SSHFolderTreeItem('Prod/EU', 1).tooltip, 'Prod/EU — 1 connection');
    });

    test('carries a decoration URI so the badge can be attached', () => {
        const item = new SSHFolderTreeItem('Prod/EU', 2);

        assert.strictEqual(item.resourceUri?.scheme, 'ssh-folder');
        assert.strictEqual(item.resourceUri?.path, '/Prod/EU');
    });
});

suite('activity bar badge', () => {
    test('shows nothing when no connection is live', () => {
        assert.strictEqual(activeConnectionBadge([]), undefined);
        assert.strictEqual(activeConnectionBadge([connection(), connection()]), undefined);
    });

    test('counts only connections with a client', () => {
        const live = { ...connection({ id: 'a', host: 'a' }), client: {} as never };
        const badge = activeConnectionBadge([live, connection({ id: 'b', host: 'b' })]);

        assert.strictEqual(badge?.value, 1);
    });

    test('uses the singular for one connection', () => {
        const live = { ...connection(), client: {} as never };

        assert.match(activeConnectionBadge([live])?.tooltip ?? '', /^1 active SSH connection$/);
    });

    test('uses the plural for several', () => {
        const live = [1, 2, 3].map(i => ({ ...connection({ id: `h${i}`, host: `h${i}` }), client: {} as never }));
        const badge = activeConnectionBadge(live);

        assert.strictEqual(badge?.value, 3);
        assert.match(badge?.tooltip ?? '', /^3 active SSH connections$/);
    });
});

suite('connectionPicks', () => {
    test('offers live connections before idle ones', () => {
        const picks = connectionPicks([
            connection({ host: 'idle' }),
            connection({ host: 'live', client: {} as never }),
        ]);

        assert.deepStrictEqual(
            picks.map(pick => pick.label),
            ['Connected', '$(vm-active) live', 'Not connected', '$(vm-outline) idle']
        );
    });

    test('sorts by host within a group', () => {
        const picks = connectionPicks([
            connection({ host: 'c' }),
            connection({ host: 'a' }),
            connection({ host: 'b' }),
        ]);

        assert.deepStrictEqual(
            picks.filter(pick => pick.connection).map(pick => pick.connection?.host),
            ['a', 'b', 'c']
        );
    });

    test('omits a group that has no members', () => {
        const picks = connectionPicks([connection({ host: 'idle' })]);

        assert.deepStrictEqual(
            picks.map(pick => pick.label),
            ['Not connected', '$(vm-outline) idle']
        );
    });

    test('shows the target and the folder without putting them in the label', () => {
        const [, pick] = connectionPicks([connection({ user: 'root', vFolderTag: 'prod/eu' })]);

        assert.strictEqual(pick.label, '$(vm-outline) web');
        assert.strictEqual(pick.description, 'root@10.0.0.5');
        assert.strictEqual(pick.detail, '$(folder) prod/eu');
    });

    test('separators carry no connection, so they cannot be picked', () => {
        const [separator] = connectionPicks([connection()]);

        assert.strictEqual(separator.connection, undefined);
    });
});
