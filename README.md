# SSH Multi Connect README

This extension 'ssh-multi-connect' allows you to manage multiple SSH connections with terminals and remote files directly from Visual Studio Code at same time.

## Features

- Manage multiple SSH connections.
- Connect and disconnect from SSH servers.
- Browse and manage remote files.
- Open remote files in the editor and save changes back to the server.
- Open remote files in the editor and save changes back to the server.
- Organize SSH connections into groups for easy access.

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

## [0.0.5] - 2025/04/17

### Added
- Added support for SSH folder grouping, allowing users to Organize SSH connections into groups for easier navigation and management.

### Fixed
- Resolved an issue where `sshpass` detection failed on certain Linux distributions due to incorrect path handling.
- Fixed a bug causing intermittent failures when refreshing the remote file view, ensuring consistent updates to the file list.
- Addressed minor UI glitches in the remote file view when handling large directories.

### Changed
- Reworked `sshutils` to improve code maintainability and performance, including refactoring SSH connection handling and error management.
- Improved the performance of the remote file view refresh operation by optimizing the underlying SSH commands and reducing redundant network calls.
- Enhanced error messages for failed SSH connections to provide more actionable feedback to users.

## [0.0.4] - 2025/03/06

### Added
- Added the ability to create a new file in the remote file view.

### Fixed
- Removed refused commands on remote file view.

## [0.0.3] - 2025/03/05

### Added
- Added supported remote extension for ssh-remote and wsl

## [0.0.2] - 2025/02/25

### Added
- Added support for detecting and installing `sshpass` on various Linux distributions.
- Added the ability to create a new folder in the remote file view.
- Added a refresh button to the remote file view for manual refresh.

## [0.0.1] - 2025/02/24

- First pre-release