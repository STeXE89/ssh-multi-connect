# SSH Multi Connect README

This extension 'ssh-multi-connect' allows you to manage multiple SSH connections with terminals and remote files directly from Visual Studio Code at same time.

## Features

- Manage multiple SSH connections.
- Connect and disconnect from SSH servers.
- Browse and manage remote files.
- Open remote files in the editor and save changes back to the server.

## Requirements

- Visual Studio Code version 1.96.0 or higher.
- `sshpass` installed on your local machine for password-based SSH connections.

## Extension Settings

This extension contributes the following settings:

* `sshMultiConnect.enable`: Enable/disable this extension.

## Known Issues

- Currently, work only on unix-like systems, windows not supported.
- The extension may not handle large file transfers efficiently.

## Release Notes

Below some last release note, for more details see the CHANGELOG.md

## [0.0.1] - 2025/02/24

- First pre-release