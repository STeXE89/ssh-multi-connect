import * as os from 'os';
import { exec, execSync } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { readFile, writeFile, fileExists, ensureDirectoryExists, ensureFileExists } from './fileUtils';

const SSH_CONFIG_DIR = path.join(os.homedir(), '.ssh');
const SSH_CONFIG_PATH = path.join(SSH_CONFIG_DIR, 'config');
const SSH_KNOWN_HOSTS_PATH = path.join(SSH_CONFIG_DIR, 'known_hosts');

export interface SSHConnection {
    host: string;
    hostname: string;
    user?: string;
    port?: number;
    identityFile?: string;
    proxyCommand?: string;
    forwardAgent?: boolean;
    localForward?: string;
    remoteForward?: string;
    compression?: boolean;
    serverAliveInterval?: number;
    serverAliveCountMax?: number;
    logLevel?: string;
    vFolderTag?: string;
}

export const SSH_DEFAULT_PORT = 22;

/**
 * Checks if sshpass is installed and prompts the user to install it if not.
 * This function is only applicable for Linux systems.
 * It detects the Linux distribution and constructs the appropriate installation command.
 * If the user agrees, it opens a terminal and executes the command.
 * If the user declines, it does nothing.
 * If the OS is not Linux, it shows a warning message.
 * @returns {void}
 */
export function checkAndInstallSshpass() {
    exec('sshpass -V', (error) => {
        if (error) {
            vscode.window.showWarningMessage('sshpass is not installed. Do you want to install it?', 'Yes', 'No').then(selection => {
                if (selection === 'Yes') {
                    const platform = os.platform();
                    let installCommand = '';

                    if (platform === 'linux') {
                        exec('cat /etc/*-release', (releaseError, stdout) => {
                            if (releaseError) {
                                vscode.window.showErrorMessage('Failed to detect Linux distribution.');
                                return;
                            }

                            if (stdout.includes('Ubuntu') || stdout.includes('Debian')) {
                                installCommand = 'sudo apt-get install -y sshpass';
                            } else if (stdout.includes('Arch')) {
                                installCommand = 'sudo pacman -S --noconfirm sshpass';
                            } else if (stdout.includes('Red Hat') || stdout.includes('CentOS') || stdout.includes('Fedora')) {
                                installCommand = 'sudo yum install -y sshpass';
                            } else {
                                vscode.window.showErrorMessage('sshpass installation is not supported on this Linux distribution.');
                                return;
                            }

                            const terminal = vscode.window.createTerminal('Install sshpass');
                            terminal.show();
                            terminal.sendText(installCommand);
                        });
                    } else {
                        vscode.window.showErrorMessage('sshpass installation is not supported on this OS.');
                    }
                }
            });
        }
    });
}

/**
 * Beautifies and formats the ssh_config file.
 */
export const beautifySSHConfig = (): void => {
    try {
        const content = readFile(SSH_CONFIG_PATH);
        const lines = content.split('\n');
        const formattedLines: string[] = [];
        let insideHostBlock = false;

        for (const line of lines) {
            if (line.trim().startsWith('Host ')) {
                // Add a blank line before a new Host block (except at the start of the file)
                if (formattedLines.length > 0 && formattedLines[formattedLines.length - 1].trim() !== '') {
                    formattedLines.push('');
                }
                formattedLines.push(line.trim()); // Add the Host line
                insideHostBlock = true;
            } else if (insideHostBlock && line.trim() !== '' && !line.startsWith(' ')) {
                // Indent lines inside a Host block that are missing indentation
                formattedLines.push(`  ${line.trim()}`);
            } else {
                // Add the line as is (preserve indentation or empty lines)
                formattedLines.push(line);
                if (line.trim() === '') {
                    insideHostBlock = false; // End of the Host block
                }
            }
        }

        // Join the formatted lines and ensure no more than one blank line between entries
        const formattedContent = formattedLines
            .join('\n')
            .replace(/\n{3,}/g, '\n\n'); // Ensure no more than one blank line between entries

        writeFile(SSH_CONFIG_PATH, `${formattedContent.trim()}\n`, 0o600);
    } catch (error) {
        console.error('Error beautifying ssh_config:', error);
    }
};

/**
 * Builds the SSH connection entry as a string.
 * @param connection The SSH connection details.
 * @returns The formatted connection entry.
 */
const buildConnectionEntry = (connection: SSHConnection): string => {
    const {
        host,
        hostname,
        user,
        port,
        identityFile,
        proxyCommand,
        forwardAgent,
        localForward,
        remoteForward,
        compression,
        serverAliveInterval,
        serverAliveCountMax,
        logLevel,
        vFolderTag,
    } = connection;

    const entryLines = [
        `Host ${host}`,
        vFolderTag ? `  # vFolderTag: ${vFolderTag}` : null,
        `  HostName ${hostname}`,
        user ? `  User ${user}` : null,
        port ? `  Port ${port}` : null,
        identityFile ? `  IdentityFile ${identityFile}` : null,
        proxyCommand ? `  ProxyCommand ${proxyCommand}` : null,
        forwardAgent !== undefined ? `  ForwardAgent ${forwardAgent ? 'yes' : 'no'}` : null,
        localForward ? `  LocalForward ${localForward}` : null,
        remoteForward ? `  RemoteForward ${remoteForward}` : null,
        compression !== undefined ? `  Compression ${compression ? 'yes' : 'no'}` : null,
        serverAliveInterval ? `  ServerAliveInterval ${serverAliveInterval}` : null,
        serverAliveCountMax ? `  ServerAliveCountMax ${serverAliveCountMax}` : null,
        logLevel ? `  LogLevel ${logLevel}` : null,
    ];

    return entryLines.filter(Boolean).join('\n');
};

/**
 * Inserts or updates a connection in the ssh_config file.
 * If the host already exists, it updates the existing entry.
 * @param connection The SSH connection details.
 */
export const insertOrUpdateConnection = (connection: SSHConnection): void => {
    try {
        ensureDirectoryExists(SSH_CONFIG_DIR, 0o700);
        ensureFileExists(SSH_CONFIG_PATH, 0o600);
        const content = readFile(SSH_CONFIG_PATH);
        const lines = content.split('\n');
        let updatedContent = '';
        let isTargetHost = false;
        let isUpdated = false;

        for (const line of lines) {
            if (line.startsWith('Host ')) {
                if (isTargetHost) {
                    updatedContent += `${buildConnectionEntry(connection)}\n`;
                    isUpdated = true;
                    isTargetHost = false;
                }
                const [, host] = line.split(' ');
                isTargetHost = host === connection.host;
            }

            if (!isTargetHost || isUpdated) {
                updatedContent += `${line}\n`;
            }
        }

        if (!isUpdated) {
            updatedContent += `\n${buildConnectionEntry(connection)}\n`;
        }

        writeFile(SSH_CONFIG_PATH, `${updatedContent.trim()}\n`, 0o600);
        beautifySSHConfig();
    } catch (error) {
        console.error('Error inserting or updating connection:', error);
    }
};

/**
 * Removes a connection from the ssh_config file.
 * @param host The host name of the connection to remove.
 */
export const removeConnection = (host: string): void => {
    try {
        const content = readFile(SSH_CONFIG_PATH);
        const lines = content.split('\n');
        const updatedLines: string[] = [];
        let insideHostBlock = false;
        let skipComments = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (line.startsWith('Host ')) {
                // Check if this is the Host block to remove
                const [, currentHost] = line.split(' ');
                if (currentHost === host) {
                    insideHostBlock = true; // Start skipping this block
                    skipComments = true; // Also skip comments directly above this block

                    // Remove any preceding comments
                    while (updatedLines.length > 0 && updatedLines[updatedLines.length - 1].trim().startsWith('#')) {
                        updatedLines.pop();
                    }

                    continue;
                }
                insideHostBlock = false; // End skipping if it's a new Host block
            }

            if (!insideHostBlock) {
                updatedLines.push(line); // Keep lines that are not part of the block to remove
            }
        }

        // Write the updated content back to the ssh_config file
        writeFile(SSH_CONFIG_PATH, `${updatedLines.join('\n').trim()}\n`, 0o600);

        // Beautify the ssh_config file after removal
        beautifySSHConfig();

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
    try {
        const connections = getAllConnections();
        return connections.find(conn => conn.host === host) || null;
    } catch (error) {
        console.error('Error retrieving connection:', error);
        return null;
    }
};

/**
 * Retrieves all SSH connections from the ssh_config file.
 * @returns An array of SSHConnection objects.
 */
export const getAllConnections = (): SSHConnection[] => {
    try {
        const content = readFile(SSH_CONFIG_PATH);
        const lines = content.split('\n');
        const connections: SSHConnection[] = [];
        let currentConnection: SSHConnection | null = null;

        for (const line of lines) {
            if (line.startsWith('Host ')) {
                if (currentConnection) {
                    connections.push(currentConnection);
                }
                const [, host] = line.split(' ');
                currentConnection = { host, hostname: '' };
            } else if (currentConnection) {
                const [key, ...valueParts] = line.trim().split(' ');
                const value = valueParts.join(' ');

                switch (key) {
                    case 'HostName':
                        currentConnection.hostname = value;
                        break;
                    case 'User':
                        currentConnection.user = value;
                        break;
                    case 'Port':
                        currentConnection.port = parseInt(value, 10);
                        break;
                    case 'IdentityFile':
                        currentConnection.identityFile = value;
                        break;
                    case 'ProxyCommand':
                        currentConnection.proxyCommand = value;
                        break;
                    case 'ForwardAgent':
                        currentConnection.forwardAgent = value === 'yes';
                        break;
                    case 'LocalForward':
                        currentConnection.localForward = value;
                        break;
                    case 'RemoteForward':
                        currentConnection.remoteForward = value;
                        break;
                    case 'Compression':
                        currentConnection.compression = value === 'yes';
                        break;
                    case 'ServerAliveInterval':
                        currentConnection.serverAliveInterval = parseInt(value, 10);
                        break;
                    case 'ServerAliveCountMax':
                        currentConnection.serverAliveCountMax = parseInt(value, 10);
                        break;
                    case 'LogLevel':
                        currentConnection.logLevel = value;
                        break;
                    case '#':
                        if (value.startsWith('vFolderTag:')) {
                            currentConnection.vFolderTag = value.split(': ')[1];
                        }
                        break;
                }
            }
        }

        if (currentConnection) {
            connections.push(currentConnection);
        }

        return connections;
    } catch (error) {
        console.error('Error retrieving all connections:', error);
        return [];
    }
};

/**
 * Ensures the identity file exists and has the correct permissions.
 * @param host The host name for the connection.
 * @returns The path to the identity file.
 */
export const createIdentityFile = (host: string): string => {
    const destinationIdentityFile = path.join(SSH_CONFIG_DIR, `${host}_key`);

    // Ensure the SSH config directory exists
    ensureDirectoryExists(SSH_CONFIG_DIR, 0o700);

    // Ensure the identity file exists
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

    // Check if the identity file exists
    if (!fileExists(identityFile)) {
        throw new Error(`Identity file not found: ${identityFile}`);
    }

    return identityFile;
};

/**
 * Adds or updates the fingerprint of a host in the known_hosts file.
 * If the host's fingerprint has changed, it replaces the existing entry.
 * @param hostname The hostname or IP address of the server.
 * @param fingerprint The fingerprint of the server's public key.
 */
export const addKnownHost = (hostname: string, fingerprint: string): void => {
    try {
        // Ensure the known_hosts file exists
        ensureFileExists(SSH_KNOWN_HOSTS_PATH, 0o600);

        // Check if the host already exists in known_hosts
        const { exists, key: existingFingerprint } = isKnownHost(hostname);

        if (exists) {
            // If the fingerprint exists but is different, remove the old entry
            if (existingFingerprint && existingFingerprint !== fingerprint) {
                console.log(`Host "${hostname}" fingerprint has changed. Updating known_hosts.`);
                removeKnownHost(hostname);
            } else {
                console.log(`Host "${hostname}" is already in known_hosts with the correct fingerprint.`);
                return; // No need to add the fingerprint again
            }
        }

        // Add the new fingerprint to known_hosts
        const publicKey = execSync(`ssh-keyscan -t rsa ${hostname}`, { stdio: 'pipe' }).toString().trim();
        execSync(`echo "${publicKey}" >> "${SSH_KNOWN_HOSTS_PATH}"`);
        console.log(`Host "${hostname}" added to known_hosts with fingerprint.`);
    } catch (error) {
        console.error(`Error adding or updating known host "${hostname}":`, error);
    }
};

/**
 * Removes the fingerprint of a host from the known_hosts file.
 * @param hostname The hostname or IP address of the server to remove.
 */
export const removeKnownHost = (hostname: string): void => {
    try {
        // Ensure the known_hosts file exists
        if (!fileExists(SSH_KNOWN_HOSTS_PATH)) {
            console.log(`known_hosts file does not exist. Nothing to remove.`);
            return;
        }

        // Use ssh-keygen to remove the host entry
        execSync(`ssh-keygen -R "${hostname}" -f "${SSH_KNOWN_HOSTS_PATH}"`);
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
        // Ensure the known_hosts file exists
        if (!fileExists(SSH_KNOWN_HOSTS_PATH)) {
            return { exists: false, key: null };
        }

        // Use ssh-keygen to check if the host exists
        const result = execSync(`ssh-keygen -F "${hostname}" -f "${SSH_KNOWN_HOSTS_PATH}"`, { stdio: 'pipe' }).toString().trim();

        if (result.length > 0) {
            // Use ssh-keygen to extract the fingerprint of the existing key
            const fingerprint = execSync(`echo "${result}" | ssh-keygen -lf -`, { stdio: 'pipe' }).toString().trim();
            const fingerprintMatch = fingerprint.match(/SHA256:[^\s]+/);
            return { exists: true, key: fingerprintMatch ? fingerprintMatch[0] : null };
        }

        return { exists: false, key: null };
    } catch (error) {
        // If ssh-keygen fails, assume the host is not in known_hosts
        return { exists: false, key: null };
    }
};

/**
 * Retrieves the fingerprint of a host's public key using ssh-keyscan and ssh-keygen.
 * @param hostname The hostname or IP address of the server.
 * @returns The fingerprint of the host's public key.
 * @throws An error if the ssh-keyscan or ssh-keygen command fails.
 */
export const getHostKeyFromKeyscan = (hostname: string): string => {
    try {
        // Use ssh-keyscan to get the public key
        const publicKey = execSync(`ssh-keyscan -t rsa ${hostname}`, { stdio: 'pipe' }).toString().trim();
        if (!publicKey) {
            throw new Error(`No key found for host "${hostname}" using ssh-keyscan.`);
        }

        // Use ssh-keygen to compute the fingerprint of the public key
        const fingerprint = execSync(`echo "${publicKey}" | ssh-keygen -lf -`, { stdio: 'pipe' }).toString().trim();
        const fingerprintMatch = fingerprint.match(/SHA256:[^\s]+/);
        if (!fingerprintMatch) {
            throw new Error(`Failed to extract fingerprint for host "${hostname}".`);
        }

        return fingerprintMatch[0]; // Return the SHA256 fingerprint
    } catch (error) {
        console.error(`Error retrieving host fingerprint for "${hostname}" using ssh-keyscan:`, error);
        throw new Error(`Failed to retrieve host fingerprint for "${hostname}".`);
    }
};