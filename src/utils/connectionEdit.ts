/**
 * The editable settings of a connection, and the rules for changing them.
 *
 * Pure: a field list in, a new connection or an error message out. The
 * prompting and the writing to ssh_config happen above this.
 */

import { SSHConnection, SSH_DEFAULT_PORT } from './sshConfig';
import { isValidHostname } from './shell';
import { parseProxyJump } from './proxyJump';

/** Which setting is being changed. */
export type EditableField = 'host' | 'hostname' | 'user' | 'port' | 'proxyJump' | 'identityFile';

/** One row of the editor's picker. */
export interface FieldDescriptor {
    field: EditableField;
    /** The ssh_config keyword, which is what the user recognises. */
    label: string;
    /** The current value, or a note that there is none. */
    value: string;
    /** What the input box should start with. */
    current: string;
    prompt: string;
    /** Whether clearing it is allowed. */
    optional: boolean;
}

const NOT_SET = '(not set)';

/**
 * Describes every editable setting of a connection.
 *
 * @param connection The connection being edited.
 * @returns The rows to offer, in the order they matter.
 */
export function editableFields(connection: SSHConnection): FieldDescriptor[] {
    return [
        {
            field: 'host',
            label: 'Host',
            value: connection.host,
            current: connection.host,
            prompt: 'The name this connection is listed under',
            optional: false,
        },
        {
            field: 'hostname',
            label: 'HostName',
            value: connection.hostname,
            current: connection.hostname,
            prompt: 'The address to connect to',
            optional: false,
        },
        {
            field: 'user',
            label: 'User',
            value: connection.user ?? NOT_SET,
            current: connection.user ?? '',
            prompt: 'The account to log in as',
            optional: true,
        },
        {
            field: 'port',
            label: 'Port',
            value: String(connection.port ?? SSH_DEFAULT_PORT),
            current: String(connection.port ?? SSH_DEFAULT_PORT),
            prompt: 'The port the server listens on',
            optional: true,
        },
        {
            field: 'proxyJump',
            label: 'ProxyJump',
            value: connection.proxyJump ?? NOT_SET,
            current: connection.proxyJump ?? '',
            prompt: 'Jump hosts, comma separated, as [user@]host[:port]. Empty for a direct connection',
            optional: true,
        },
        {
            field: 'identityFile',
            label: 'IdentityFile',
            value: connection.identityFile ?? NOT_SET,
            current: connection.identityFile ?? '',
            prompt: 'Path to the private key. Empty to authenticate with a password',
            optional: true,
        },
    ];
}

/**
 * Checks a new value for a setting.
 *
 * Returns the message an input box should show, so the user is stopped before
 * a bad value reaches ssh_config rather than after.
 *
 * @param field The setting being changed.
 * @param value The text entered.
 * @returns An error message, or undefined when the value is fine.
 */
export function validateField(field: EditableField, value: string): string | undefined {
    const trimmed = value.trim();

    switch (field) {
        case 'host':
            if (!trimmed) {
                return 'A name is required.';
            }
            return /\s/.test(trimmed) ? 'A host name cannot contain spaces.' : undefined;

        case 'hostname':
            if (!trimmed) {
                return 'An address is required.';
            }
            return isValidHostname(trimmed) ? undefined : 'That is not a valid host name or address.';

        case 'user':
            return /\s/.test(trimmed) ? 'A user name cannot contain spaces.' : undefined;

        case 'port': {
            if (!trimmed) {
                return undefined;
            }
            const port = Number(trimmed);
            return /^\d{1,5}$/.test(trimmed) && port >= 1 && port <= 65535
                ? undefined
                : 'Enter a port between 1 and 65535.';
        }

        case 'proxyJump':
            return !trimmed || parseProxyJump(trimmed)
                ? undefined
                : 'Each hop must be [user@]host[:port], separated by commas.';

        case 'identityFile':
            return undefined;
    }
}

/**
 * Applies a new value to a connection.
 *
 * The value is assumed to have passed `validateField`. An empty value clears
 * an optional setting, so the directive is left out of ssh_config entirely
 * rather than written as an empty line.
 *
 * @param connection The connection being edited.
 * @param field The setting being changed.
 * @param value The new value.
 * @returns A copy of the connection with the change applied.
 */
export function applyEdit(connection: SSHConnection, field: EditableField, value: string): SSHConnection {
    const trimmed = value.trim();
    const edited: SSHConnection = { ...connection };

    switch (field) {
        case 'host':
            edited.host = trimmed;
            break;
        case 'hostname':
            edited.hostname = trimmed;
            break;
        case 'user':
            edited.user = trimmed || undefined;
            break;
        case 'port':
            edited.port = trimmed ? Number(trimmed) : undefined;
            break;
        case 'proxyJump':
            edited.proxyJump = trimmed || undefined;
            break;
        case 'identityFile':
            edited.identityFile = trimmed || undefined;
            break;
    }

    return edited;
}

/**
 * Reports whether an edit renames the ssh_config block.
 *
 * A rename has to remove the old block as well as write the new one, and the
 * rest of the extension keys a live connection by its name, so it is only
 * safe while the host is disconnected.
 *
 * @param connection The connection before the edit.
 * @param edited The connection after it.
 * @returns True when the name changed.
 */
export function isRename(connection: SSHConnection, edited: SSHConnection): boolean {
    return connection.host !== edited.host;
}
