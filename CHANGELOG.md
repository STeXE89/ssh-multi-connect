# Change Log

All notable changes to the "ssh-multi-connect" extension will be documented in this file.

## [0.0.8] - 2025/04/30

### Fixed
- Fixed file path for multi command panel

## [0.0.7] - 2025/04/30

### Added
- New panel function allowing users to execute commands on selected multiple hosts simultaneously.

### Changed
- General code optimizations.

## [0.0.6] - 2025/04/23

### Fixed
- Fixed passing hostname instead of host (saved connection name) related to known_hosts.
- Security issue fixed: prevented password from being displayed in terminal tooltip command line.

## Changed
- General code optimization/cleanup.

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