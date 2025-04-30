const fs = require('fs');
const path = require('path');

const packageJson = require('./package.json');
const changelog = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf-8');

// Regular expression to match release notes with descriptions
const releaseNotesRegex = /## \[\d+\.\d+\.\d+\].*?(?=\s*\r\n## |$)/gs;
const releaseNotes = changelog.match(releaseNotesRegex) || [];
const limitedReleaseNotes = releaseNotes.slice(0, 10).join('\n');

const readmeContent = `
# ${packageJson.displayName} README

${packageJson.description}

## Features

- Manage multiple SSH connections.
- Connect and disconnect from SSH servers.
- Browse and manage remote files.
- Open remote files in the editor and save changes back to the server.
- Organize SSH connections into groups for easy access.
- Execute commands on multiple hosts simultaneously.

## Requirements

- Visual Studio Code version 1.96.0 or higher.
- \`sshpass\` installed on your local machine for password-based SSH connections.

## Extension Settings

This extension contributes the following settings:

* \`sshMultiConnect.enable\`: Enable/disable this extension.

## Known Issues

- Currently, work only on unix-like systems, windows not supported.
- The extension may not handle large file transfers efficiently.

## Release Notes

Below some last release note, for more details see the CHANGELOG.md

${limitedReleaseNotes}

`;

fs.writeFileSync(path.join(__dirname, 'README.md'), readmeContent.trim());
console.log('README.md generated successfully.');