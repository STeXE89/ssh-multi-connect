/**
 * A host key the tests can rely on.
 *
 * `ssh2.utils.generateKeyPairSync('ed25519')` returns a key its own `Server`
 * refuses to parse roughly once in two hundred -- "Malformed OpenSSH private
 * key". A suite that starts eight servers therefore failed about one run in
 * twenty, from nothing the extension had done.
 *
 * So the key is generated once, checked by the thing that will use it, and
 * shared. Checking is what matters; reuse just makes the suite quicker.
 */

import { Server, utils } from 'ssh2';

let cached: string | undefined;

/**
 * Returns a private key that ssh2's server will accept.
 *
 * @returns The key, in OpenSSH format.
 */
export function testHostKey(): string {
    if (cached) {
        return cached;
    }

    for (let attempt = 0; attempt < 10; attempt++) {
        const key = utils.generateKeyPairSync('ed25519').private;

        try {
            // The only reliable check is the constructor that rejects it.
            new Server({ hostKeys: [key] }).close();
            cached = key;
            return key;
        } catch {
            // Generated badly; try again.
        }
    }

    throw new Error('ssh2 could not generate a host key its own server accepts');
}
