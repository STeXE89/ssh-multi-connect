import * as assert from 'assert';
import { editableFields, validateField, applyEdit, isRename } from '../utils/connectionEdit';
import { buildConnectionEntry, parseSshConfig, SSHConnection } from '../utils/sshConfig';

const connection = (overrides: Partial<SSHConnection> = {}): SSHConnection => ({
    host: 'web',
    hostname: '10.0.0.5',
    ...overrides,
});

suite('connectionEdit: the field list', () => {
    test('offers every setting the extension writes', () => {
        assert.deepStrictEqual(
            editableFields(connection()).map(field => field.label),
            ['Host', 'HostName', 'User', 'Port', 'ProxyJump', 'IdentityFile']
        );
    });

    test('shows the current value, and says when there is none', () => {
        const fields = editableFields(connection({ user: 'root', proxyJump: 'bastion' }));
        const value = (label: string) => fields.find(field => field.label === label)?.value;

        assert.strictEqual(value('User'), 'root');
        assert.strictEqual(value('ProxyJump'), 'bastion');
        assert.strictEqual(value('IdentityFile'), '(not set)');
    });

    test('shows the default port rather than nothing', () => {
        assert.strictEqual(editableFields(connection()).find(field => field.label === 'Port')?.value, '22');
    });

    test('starts the input box empty for a setting that is not set', () => {
        const proxy = editableFields(connection()).find(field => field.label === 'ProxyJump');

        assert.strictEqual(proxy?.current, '');
        assert.ok(proxy?.optional);
    });
});

suite('connectionEdit: validation', () => {
    test('requires a name and an address', () => {
        assert.ok(validateField('host', '  '));
        assert.ok(validateField('hostname', ''));
        assert.strictEqual(validateField('host', 'web'), undefined);
        assert.strictEqual(validateField('hostname', '10.0.0.5'), undefined);
    });

    test('rejects a name with spaces, which ssh_config cannot express', () => {
        assert.ok(validateField('host', 'my host'));
        assert.ok(validateField('user', 'my user'));
    });

    test('rejects an address that is not one', () => {
        assert.ok(validateField('hostname', 'not a host'));
        assert.ok(validateField('hostname', 'http://example.com/x'));
    });

    test('checks the port range', () => {
        assert.strictEqual(validateField('port', '2222'), undefined);
        assert.strictEqual(validateField('port', ''), undefined);
        assert.ok(validateField('port', '0'));
        assert.ok(validateField('port', '99999'));
        assert.ok(validateField('port', 'ssh'));
    });

    test('checks a jump chain the same way the connection will read it', () => {
        assert.strictEqual(validateField('proxyJump', 'jump@bastion:2222,second'), undefined);
        assert.strictEqual(validateField('proxyJump', ''), undefined);
        assert.ok(validateField('proxyJump', 'bastion:not-a-port'));
        assert.ok(validateField('proxyJump', '@bastion'));
    });
});

suite('connectionEdit: applying a change', () => {
    test('sets a value', () => {
        assert.strictEqual(applyEdit(connection(), 'proxyJump', ' bastion ').proxyJump, 'bastion');
        assert.strictEqual(applyEdit(connection(), 'port', '2222').port, 2222);
    });

    test('an empty value clears an optional setting rather than writing a blank line', () => {
        const cleared = applyEdit(connection({ proxyJump: 'bastion', user: 'root' }), 'proxyJump', '');

        assert.strictEqual(cleared.proxyJump, undefined);
        assert.ok(!buildConnectionEntry(cleared).includes('ProxyJump'));
    });

    test('leaves every other setting alone', () => {
        const before = connection({ user: 'root', port: 2222, identityFile: '/k', vFolderTag: 'prod' });
        const after = applyEdit(before, 'proxyJump', 'bastion');

        assert.deepStrictEqual({ ...after, proxyJump: undefined }, { ...before, proxyJump: undefined });
    });

    test('survives a round trip through ssh_config', () => {
        const edited = applyEdit(connection({ user: 'root' }), 'proxyJump', 'jump@bastion:2222');
        const [reparsed] = parseSshConfig(buildConnectionEntry(edited));

        assert.strictEqual(reparsed.proxyJump, 'jump@bastion:2222');
        assert.strictEqual(reparsed.user, 'root');
    });

    test('recognises a rename, which has to move the block', () => {
        const before = connection();

        assert.ok(isRename(before, applyEdit(before, 'host', 'renamed')));
        assert.ok(!isRename(before, applyEdit(before, 'hostname', '10.0.0.9')));
    });
});
