/**
 * The wording of the credential prompts.
 *
 * Connecting through a bastion asks for a password more than once, and an
 * input box that says only "Password" gives no way to tell which host is
 * asking. Each prompt therefore names the account, its place in the chain, and
 * where the chain is going.
 */

/** What to put on an input box. */
export interface PasswordPrompt {
    /** The bar above the box; omitted for a plain single-host connection. */
    title?: string;
    placeHolder: string;
    prompt: string;
}

/**
 * Names an account the way ssh does.
 *
 * @param username The account.
 * @param host The address.
 * @param port The port.
 * @returns A label such as `don@donatello:22`.
 */
export function accountLabel(username: string, host: string, port: number): string {
    return `${username || '?'}@${host}:${port}`;
}

/**
 * The prompt for a bastion's password.
 *
 * @param account The account being authenticated.
 * @param index The hop's position, counting from zero.
 * @param total How many hops the chain has.
 * @param destination The host the chain is on the way to.
 * @returns The input box wording.
 */
export function hopPasswordPrompt(account: string, index: number, total: number, destination: string): PasswordPrompt {
    return {
        title: hopTitle(index, total),
        placeHolder: `Password for ${account}`,
        prompt: `Jump host, on the way to ${destination}`,
    };
}

/**
 * The prompt for a bastion's key passphrase.
 *
 * @param account The account being authenticated.
 * @param identityFile The key being unlocked.
 * @param index The hop's position, counting from zero.
 * @param total How many hops the chain has.
 * @param destination The host the chain is on the way to.
 * @returns The input box wording.
 */
export function hopPassphrasePrompt(
    account: string,
    identityFile: string,
    index: number,
    total: number,
    destination: string
): PasswordPrompt {
    return {
        title: hopTitle(index, total),
        placeHolder: `Passphrase for ${identityFile}`,
        prompt: `Key for ${account}, a jump host on the way to ${destination}`,
    };
}

/**
 * The prompt for the host actually being connected to.
 *
 * @param account The account being authenticated.
 * @param alias The connection's name in the tree.
 * @param via The jump hosts it is reached through, if any.
 * @returns The input box wording.
 */
export function hostPasswordPrompt(account: string, alias: string, via?: string): PasswordPrompt {
    return via
        ? {
              title: `Destination: ${alias}`,
              placeHolder: `Password for ${account}`,
              prompt: `Reached through ${via}`,
          }
        : { placeHolder: `Password for ${account}`, prompt: alias };
}

/**
 * Titles a hop by its position, saying "of N" only when there is more than one.
 *
 * @param index The hop's position, counting from zero.
 * @param total How many hops the chain has.
 * @returns The title bar text.
 */
function hopTitle(index: number, total: number): string {
    return total > 1 ? `Jump host ${index + 1} of ${total}` : 'Jump host';
}
