import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { readFile, writeFile, fileExists, ensureDirectoryExists, ensureFileExists, appendToFile } from './fileUtils';
import { SSH_DEFAULT_PORT, SSHConnection, parseSshConfig, upsertConnection, removeHost } from './sshConfig';
import { isValidHostname } from './shell';
import { knownHostsLine } from './hostKeys';
import { ConfigReader, flattenConfig, hostOrigins } from './sshConfigInclude';
import { expandHome } from './paths';

export const SSH_CONFIG_DIR = path.join(os.homedir(), '.ssh');
export const SSH_CONFIG_PATH = path.join(SSH_CONFIG_DIR, 'config');
export const SSH_KNOWN_HOSTS_PATH = path.join(SSH_CONFIG_DIR, 'known_hosts');

export { SSH_DEFAULT_PORT };
export type { SSHConnection };

/** Host key types requested from ssh-keyscan, newest first. */
const HOST_KEY_TYPES = 'ed25519,ecdsa,rsa';

/**
 * Verifies that the OpenSSH command-line tools are available.
 *
 * `ssh-keyscan` and `ssh-keygen` handle known_hosts. They ship with Linux and
 * macOS, and on Windows with the OpenSSH Client feature present by default
 * since Windows 10 1809. Reported once at activation so a missing tool does
 * not surface later as an opaque fingerprint failure. Nothing is installed
 * automatically.
 *
 * @returns True when both tools could be executed.
 */
export function checkSshTooling(): boolean {
    const missing = ['ssh-keygen', 'ssh-keyscan'].filter(tool => {
        try {
            execFileSync(tool, ['-?'], { stdio: 'ignore' });
            return false;
        } catch (error) {
            // Both exit non-zero for an unknown flag; only ENOENT means absent.
            return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
        }
    });

    if (missing.length === 0) {
        return true;
    }

    const hint =
        os.platform() === 'win32'
            ? 'Install the "OpenSSH Client" optional feature (Settings > System > Optional features), or add its folder to PATH.'
            : 'Install the OpenSSH client package for your distribution (for example openssh-client).';

    vscode.window.showWarningMessage(
        `SSH Multi Connect needs ${missing.join(' and ')} on your PATH for host key verification. ${hint}`
    );

    return false;
}

/** The filesystem, as the Include walker needs it. */
const configReader: ConfigReader = {
    read: filePath => {
        try {
            return fileExists(filePath) ? readFile(filePath) : undefined;
        } catch {
            return undefined;
        }
    },
    list: directory => {
        try {
            return fs.readdirSync(directory);
        } catch {
            return undefined;
        }
    },
};

/**
 * Reads one config file, returning an empty string when it does not exist.
 *
 * @param filePath The file to read.
 * @returns Its content.
 */
const readConfigFile = (filePath: string): string => {
    ensureDirectoryExists(SSH_CONFIG_DIR, 0o700);
    return fileExists(filePath) ? readFile(filePath) : '';
};

/**
 * Reads the ssh_config file and everything it includes.
 *
 * @returns The assembled lines, each tagged with the file it came from.
 */
const readAssembledConfig = () => {
    ensureDirectoryExists(SSH_CONFIG_DIR, 0o700);
    return flattenConfig(SSH_CONFIG_PATH, configReader, SSH_CONFIG_DIR);
};

/**
 * Inserts or updates a connection in the ssh_config file.
 * If the host already exists, its block is replaced; other blocks are left
 * byte-for-byte intact so directives this extension does not model survive.
 * @param connection The SSH connection details.
 */
export const insertOrUpdateConnection = (connection: SSHConnection): void => {
    if (connection.readOnly) {
        vscode.window.showErrorMessage(
            `"${connection.host}" is assembled from an Include, so this extension will not rewrite it. ` +
                `Edit ${connection.sourceFile ?? SSH_CONFIG_PATH} directly.`
        );
        return;
    }

    // An included host is written back where it came from; writing it to the
    // main config would leave two blocks for one name.
    const target = connection.sourceFile ?? SSH_CONFIG_PATH;

    try {
        const updated = upsertConnection(readConfigFile(target), connection);
        writeFile(target, updated, 0o600);
    } catch (error) {
        console.error('Error inserting or updating connection:', error);
        vscode.window.showErrorMessage(`Failed to save connection for host "${connection.host}".`);
    }
};

/**
 * Removes a connection from the ssh_config file.
 * @param host The host name of the connection to remove.
 */
export const removeConnection = (host: string, sourceFile?: string): void => {
    const target = sourceFile ?? SSH_CONFIG_PATH;

    try {
        const updated = removeHost(readConfigFile(target), host);
        writeFile(target, updated, 0o600);
        vscode.window.showInformationMessage(`Connection for host "${host}" has been removed.`);
    } catch (error) {
        console.error('Error removing connection:', error);
        vscode.window.showErrorMessage(`Failed to remove connection for host "${host}".`);
    }
};

/**
 * Retrieves a specific connection by host.
 * @param host The host name of the connection.
 * @returns The connection details or null if not found.
 */
export const getConnection = (host: string): SSHConnection | null => {
    return getAllConnections().find(conn => conn.host === host) ?? null;
};

/**
 * Retrieves all SSH connections from the ssh_config file.
 * @returns An array of SSHConnection objects.
 */
export const getAllConnections = (): SSHConnection[] => {
    try {
        const lines = readAssembledConfig();
        const origins = hostOrigins(lines);

        return parseSshConfig(lines.map(line => line.text).join('\n')).map(connection => {
            const origin = origins.get(connection.host);
            return origin
                ? { ...connection, sourceFile: origin.file, readOnly: origin.spansIncludes || undefined }
                : connection;
        });
    } catch (error) {
        console.error('Error retrieving all connections:', error);
        return [];
    }
};

/**
 * Resolves an `IdentityFile` path to something that can be opened.
 *
 * A config written for the `ssh` command normally says `~/.ssh/id_ed25519`,
 * which only OpenSSH expands.
 *
 * @param identityFile The path as written in the config.
 * @returns The path to read.
 */
export const resolveIdentityFile = (identityFile: string): string => expandHome(identityFile);

/**
 * Ensures the identity file exists and has the correct permissions.
 * @param host The host name for the connection.
 * @returns The path to the identity file.
 */
export const createIdentityFile = (host: string): string => {
    const destinationIdentityFile = path.join(SSH_CONFIG_DIR, `${host}_key`);

    ensureDirectoryExists(SSH_CONFIG_DIR, 0o700);

    if (!fileExists(destinationIdentityFile)) {
        writeFile(destinationIdentityFile, '', 0o600);
    }

    return destinationIdentityFile;
};

/**
 * Retrieves the identity file for the given host.
 * @param host The host name for the connection.
 * @returns The path to the identity file.
 * @throws An error if the identity file does not exist.
 */
export const getIdentityFile = (host: string): string => {
    const identityFile = path.join(SSH_CONFIG_DIR, `${host}_key`);

    if (!fileExists(identityFile)) {
        throw new Error(`Identity file not found: ${identityFile}`);
    }

    return identityFile;
};

/**
 * Runs a command without a shell and returns its trimmed stdout.
 *
 * Arguments go through as an array, so a hostile value cannot be read as
 * shell syntax.
 *
 * @param command The executable to run.
 * @param args The argument list.
 * @returns The trimmed stdout.
 */
const runCapture = (command: string, args: string[]): string =>
    execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        .toString()
        .trim();

/**
 * Fetches a host's public keys with ssh-keyscan.
 *
 * All common key types are requested; a server may publish only ed25519.
 *
 * @param hostname The hostname or IP address of the server.
 * @param port The port the server listens on.
 * @returns The known_hosts lines returned by ssh-keyscan.
 */
const keyscan = (hostname: string, port: number = SSH_DEFAULT_PORT): string => {
    if (!isValidHostname(hostname)) {
        throw new Error(`Refusing to scan an invalid hostname: "${hostname}"`);
    }
    return runCapture('ssh-keyscan', ['-p', String(port), '-t', HOST_KEY_TYPES, hostname]);
};

/**
 * Computes the SHA256 fingerprint of one or more known_hosts lines.
 *
 * @param knownHostsLines The known_hosts formatted key lines.
 * @returns The first SHA256 fingerprint found, or null.
 */
const fingerprintOf = (knownHostsLines: string): string | null => {
    if (!knownHostsLines) {
        return null;
    }
    const output = execFileSync('ssh-keygen', ['-lf', '-'], {
        input: knownHostsLines,
        stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    return output.match(/SHA256:[^\s]+/)?.[0] ?? null;
};

/**
 * Adds or updates the fingerprint of a host in the known_hosts file.
 * If the host's fingerprint has changed, it replaces the existing entry.
 * @param hostname The hostname or IP address of the server.
 * @param fingerprint The expected fingerprint of the server's public key.
 * @param port The port the server listens on.
 */
export const addKnownHost = (hostname: string, fingerprint: string, port: number = SSH_DEFAULT_PORT): void => {
    try {
        ensureFileExists(SSH_KNOWN_HOSTS_PATH, 0o600);

        const { exists, key: existingFingerprint } = isKnownHost(hostname);

        if (exists) {
            if (existingFingerprint && existingFingerprint !== fingerprint) {
                console.log(`Host "${hostname}" fingerprint has changed. Updating known_hosts.`);
                removeKnownHost(hostname);
            } else {
                return;
            }
        }

        const publicKeys = keyscan(hostname, port);
        if (!publicKeys) {
            throw new Error(`ssh-keyscan returned no key for "${hostname}".`);
        }

        // fs rather than a shell redirect: the key text comes from the server.
        appendToFile(SSH_KNOWN_HOSTS_PATH, `${publicKeys}\n`);
        console.log(`Host "${hostname}" added to known_hosts.`);
    } catch (error) {
        throw error instanceof Error ? error : new Error(String(error));
    }
};

/**
 * Removes the fingerprint of a host from the known_hosts file.
 * @param hostname The hostname or IP address of the server to remove.
 */
export const removeKnownHost = (hostname: string): void => {
    try {
        if (!fileExists(SSH_KNOWN_HOSTS_PATH)) {
            return;
        }

        runCapture('ssh-keygen', ['-R', hostname, '-f', SSH_KNOWN_HOSTS_PATH]);
        console.log(`Host "${hostname}" removed from known_hosts.`);
    } catch (error) {
        console.error(`Error removing known host "${hostname}":`, error);
    }
};

/**
 * Checks if a hostname's fingerprint exists in the known_hosts file.
 * @param hostname The hostname or IP address to check.
 * @returns An object containing `exists` (boolean) and `key` (string or null).
 */
export const isKnownHost = (hostname: string): { exists: boolean; key: string | null } => {
    try {
        if (!fileExists(SSH_KNOWN_HOSTS_PATH)) {
            return { exists: false, key: null };
        }

        const found = runCapture('ssh-keygen', ['-F', hostname, '-f', SSH_KNOWN_HOSTS_PATH]);
        if (!found) {
            return { exists: false, key: null };
        }

        // `ssh-keygen -F` prefixes a `# Host ... found` comment line.
        const keyLines = found
            .split('\n')
            .filter(line => line.trim() && !line.trim().startsWith('#'))
            .join('\n');

        return { exists: true, key: fingerprintOf(keyLines) };
    } catch {
        // ssh-keygen exits non-zero when the host is absent.
        return { exists: false, key: null };
    }
};

/**
 * Retrieves the fingerprint of a host's public key using ssh-keyscan and ssh-keygen.
 * @param hostname The hostname or IP address of the server.
 * @param port The port the server listens on.
 * @returns The SHA256 fingerprint of the host's public key.
 * @throws An error if the ssh-keyscan or ssh-keygen command fails.
 */
export const getHostKeyFromKeyscan = (hostname: string, port: number = SSH_DEFAULT_PORT): string => {
    try {
        const publicKeys = keyscan(hostname, port);
        if (!publicKeys) {
            throw new Error(`No key found for host "${hostname}" using ssh-keyscan.`);
        }

        const fingerprint = fingerprintOf(publicKeys);
        if (!fingerprint) {
            throw new Error(`Failed to extract fingerprint for host "${hostname}".`);
        }

        return fingerprint;
    } catch {
        throw new Error(`Failed to retrieve host fingerprint for "${hostname}".`);
    }
};

/**
 * Records a host key that arrived during a handshake.
 *
 * Used for hosts `ssh-keyscan` cannot reach on its own -- anything behind a
 * bastion -- where the key is only ever seen through the tunnel.
 *
 * @param hostname The address the key belongs to.
 * @param port The port it was served on.
 * @param key The key blob from the handshake.
 * @returns True when the key was written.
 */
export const rememberHostKey = (hostname: string, port: number, key: Buffer): boolean => {
    const line = knownHostsLine(hostname, port, key);
    if (!line) {
        return false;
    }

    ensureFileExists(SSH_KNOWN_HOSTS_PATH, 0o600);
    appendToFile(SSH_KNOWN_HOSTS_PATH, `${line}\n`);
    return true;
};
