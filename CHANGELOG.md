# Change Log

All notable changes to the "ssh-multi-connect" extension will be documented in this file.

## [Unreleased]

### Added

- Hosts behind a bastion, through `ProxyJump` and the `ProxyCommand` forms that mean the same thing.
- `LocalForward` and `RemoteForward` entries open as tunnels on connect.
- `ServerAliveInterval`, `ServerAliveCountMax`, `Compression` and `ForwardAgent` are honoured.
- **Connect to SSH Host...** in the command palette, listing every host with the live ones first.
- **Edit Connection...** on a host, for its address, user, port, jump hosts and key.
- Jump hosts can be set when adding a connection, and each credential prompt names the host asking.
- Optional password storage in the operating system's keychain, off by default.
- **Keep This Tunnel** writes a running tunnel to `ssh_config`, so it opens on every connect.
- Connections that drop are rebuilt on their own, reusing this session's credentials and reopening the tunnels that were running.
- **Run Command on Hosts...** runs one command on several hosts and opens a report, grouping the hosts that agree.
- The multi-command panel shows the selected hosts side by side in a split terminal group.

### Fixed

- `IdentityFile ~/.ssh/id_ed25519` failed, because a leading `~` was never expanded.
- Hosts defined in files pulled in with `Include` were invisible.
- A connection killed by suspending the machine stayed in the tree looking live, since nothing probed it and nothing watched for it closing.

## [0.0.9] - 2026/09/09

### Added

- Windows support: terminals run over the extension's own SSH connection, so `sshpass` is no longer needed.
- SSH tunnels: local and remote port forwards, with start/stop and live state.
- File Details panel: inspect a remote file or folder, and edit its permissions and ownership.
- Right-click actions on remote files, including rename and delete.
- Retry with sudo when the remote user lacks permission.
- Badges for active connections and folder contents.
- Setting to follow the selected folder in the terminal.

### Fixed

- Extension host crashed on activation.
- SSH keys without a passphrase could never connect.
- Key authentication connected to the ssh_config alias instead of the host.
- Only the first save of a remote file was uploaded.
- Live connections were dropped whenever ssh_config changed.
- Assorted tree view, cleanup and error-reporting problems.

### Security

- Removed shell injection paths, and passphrases from the command line.
- Webview output is escaped and runs under a Content-Security-Policy.
- Downloaded files are kept in a private directory.

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
