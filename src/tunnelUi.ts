import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { TunnelEntry } from './tunnels';
import {
    TunnelConfig,
    TunnelKind,
    LOOPBACK,
    ALL_INTERFACES,
    parsePort,
    validatePort,
    validateHost,
    tunnelLabel,
    tunnelFlag,
    describeTunnel,
} from './utils/tunnelModel';

/** How each state is shown in the tree. */
const STATE_PRESENTATION: Record<TunnelEntry['state'], { icon: string; colour?: string; text: string }> = {
    active: { icon: 'debug-start', colour: 'terminal.ansiGreen', text: 'active' },
    starting: { icon: 'loading~spin', text: 'starting' },
    stopped: { icon: 'debug-pause', text: 'stopped' },
    error: { icon: 'error', colour: 'errorForeground', text: 'error' },
};

/** A tunnel shown beneath its connection. */
export class SSHTunnelTreeItem extends vscode.TreeItem {
    constructor(
        public readonly connectionId: string,
        public readonly entry: TunnelEntry,
        hostLabel: string
    ) {
        super(tunnelLabel(entry.config), vscode.TreeItemCollapsibleState.None);

        const presentation = STATE_PRESENTATION[entry.state];
        const carried = entry.connectionCount > 0 ? `, ${entry.connectionCount} connection(s)` : '';

        const failing = entry.lastError ? ' · failing' : '';
        this.description = `${tunnelFlag(entry.config)} · ${presentation.text}${carried}${failing}`;
        this.tooltip = [
            describeTunnel(entry.config, hostLabel),
            `State: ${presentation.text}`,
            entry.error ? `Error: ${entry.error}` : undefined,
            entry.lastError ? `Last connection failed: ${entry.lastError}` : undefined,
        ]
            .filter(Boolean)
            .join('\n');
        this.iconPath = new vscode.ThemeIcon(
            presentation.icon,
            presentation.colour ? new vscode.ThemeColor(presentation.colour) : undefined
        );
        // Drives which inline action is offered: start or stop.
        this.contextValue = entry.state === 'active' || entry.state === 'starting' ? 'sshTunnelUp' : 'sshTunnelDown';
        this.id = `${connectionId}::${entry.config.id}`;
    }
}

/**
 * Asks the user to describe a tunnel.
 *
 * Each step can be cancelled, which abandons the whole flow.
 *
 * @param hostLabel The SSH host the tunnel would run over.
 * @returns The tunnel to create, or undefined if the user backed out.
 */
export async function promptForTunnel(hostLabel: string): Promise<TunnelConfig | undefined> {
    const kind = await pickKind(hostLabel);
    if (!kind) {
        return undefined;
    }

    const local = kind === 'local';
    const listenSide = local ? 'this machine' : hostLabel;
    const destinationSide = local ? hostLabel : 'this machine';

    const bindAddress = await pickBindAddress(listenSide);
    if (!bindAddress) {
        return undefined;
    }

    const listenPort = await askPort(
        `Port to open on ${listenSide}, which you will connect to`,
        local ? '8080' : '9090'
    );
    if (listenPort === undefined) {
        return undefined;
    }

    const destinationHost = await pickDestinationHost(destinationSide);
    if (!destinationHost) {
        return undefined;
    }

    const target = destinationHost === 'localhost' ? destinationSide : destinationHost;
    const destinationPort = await askPort(`Port on ${target}`, String(listenPort));
    if (destinationPort === undefined) {
        return undefined;
    }

    return {
        id: randomBytes(8).toString('hex'),
        kind,
        bindAddress,
        listenPort,
        destinationHost,
        destinationPort,
    };
}

/** Asks which direction the tunnel forwards. */
async function pickKind(hostLabel: string): Promise<TunnelKind | undefined> {
    const picked = await vscode.window.showQuickPick(
        [
            {
                label: '$(arrow-right) Local forward',
                detail: `-L · a port here reaches a host that ${hostLabel} can see`,
                direction: 'local' as const,
            },
            {
                label: '$(arrow-left) Remote forward',
                detail: `-R · a port on ${hostLabel} reaches a host this machine can see`,
                direction: 'remote' as const,
            },
        ],
        { placeHolder: 'What kind of tunnel?', matchOnDetail: true }
    );

    return picked?.direction;
}

/** Asks which interface the listening side binds to. */
async function pickBindAddress(listenSide: string): Promise<string | undefined> {
    const picked = await vscode.window.showQuickPick(
        [
            {
                label: '$(lock) Localhost only',
                detail: `${LOOPBACK} · reachable only from ${listenSide}`,
                address: LOOPBACK,
            },
            {
                label: '$(globe) All interfaces',
                detail: `${ALL_INTERFACES} · reachable from the network. Anyone who can reach ${listenSide} can use the tunnel.`,
                address: ALL_INTERFACES,
            },
        ],
        { placeHolder: 'Which interface should accept connections?', matchOnDetail: true }
    );

    return picked?.address;
}

/** Asks for a port, validating as the user types. */
async function askPort(prompt: string, value: string): Promise<number | undefined> {
    const entered = await vscode.window.showInputBox({
        prompt,
        value,
        validateInput: input => validatePort(input),
    });

    return entered === undefined ? undefined : parsePort(entered);
}

/**
 * Asks which host the traffic should end up at.
 *
 * The name is resolved by the machine at the far end, which is the step people
 * get wrong: reaching the server's own port means `localhost`, not the
 * server's name. Offering that as a labelled choice avoids having to know it.
 *
 * @param destinationSide The machine that will resolve the name.
 * @returns The chosen host, or undefined if the user backed out.
 */
async function pickDestinationHost(destinationSide: string): Promise<string | undefined> {
    const OTHER = '\u0000other';

    const picked = await vscode.window.showQuickPick(
        [
            {
                label: `$(server) ${destinationSide} itself`,
                detail: 'localhost · a port on the machine at the other end of this tunnel',
                host: 'localhost',
            },
            {
                label: '$(globe) Another host...',
                detail: `A machine that ${destinationSide} can reach, for example db.internal`,
                host: OTHER,
            },
        ],
        { placeHolder: `Where should the traffic end up? Resolved by ${destinationSide}.`, matchOnDetail: true }
    );

    if (!picked) {
        return undefined;
    }

    if (picked.host !== OTHER) {
        return picked.host;
    }

    const entered = await vscode.window.showInputBox({
        prompt: `Host name or address, as ${destinationSide} would resolve it`,
        placeHolder: 'db.internal',
        validateInput: input => validateHost(input),
    });

    return entered?.trim();
}
