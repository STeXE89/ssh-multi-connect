# Change Log

All notable changes to the "ssh-multi-connect" extension will be documented in this file.

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