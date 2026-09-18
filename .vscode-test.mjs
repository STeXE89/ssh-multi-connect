import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    files: 'out/test/**/*.test.js',
    mocha: {
        // Mocha's default is two seconds, which the integration tests can
        // exceed on a loaded machine: several of them generate host keys and
        // complete two or three real SSH handshakes. The whole suite runs in
        // about seven seconds, so a longer limit costs nothing and only takes
        // effect where a test would otherwise have been failed for the
        // machine's sake rather than its own.
        timeout: 20000,
    },
});
