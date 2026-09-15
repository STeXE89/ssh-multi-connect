# SSH Multi Connect README

This extension 'ssh-multi-connect' allows you to group SSH connections into folders and manage remote files and run commands on terminals even at the same time on multiple connections directly from Visual Studio Code.

## Features

- Manage multiple SSH connections.
- Connect and disconnect from SSH servers.
- Browse and manage remote files.
- Open remote files in the editor and save changes back to the server.
- Organize SSH connections into folders, with drag and drop.
- Execute commands on multiple hosts simultaneously.
- Open local and remote SSH tunnels, with start/stop control and live state.
- Inspect remote files and folders, and edit their permissions and ownership.
- Create, rename and delete remote files and folders from the right-click menu.
- Retry an operation with sudo when the remote user lacks permission.
- Run one command across hosts and read the collected output in one report.
- Upload files and folders by dragging them onto the remote tree, or by picking them.
- Move remote files and folders by dragging them within the tree.
- Select several remote entries to move, copy, download, or delete them together.
- Copy a file or folder from one host to one or more others, connecting them if needed.
- Download a remote file or folder onto this machine.
- Keep a tunnel in `ssh_config` so it opens on every connect.
- Reach hosts behind a bastion, with `ProxyJump`, set from the connection's right-click menu.
- Connect from the command palette with **Connect to SSH Host...**.
- Runs on Windows, macOS and Linux.

## Requirements

- Visual Studio Code version 1.96.0 or higher.
- The OpenSSH command-line tools (`ssh-keygen`, `ssh-keyscan`) on your PATH, used for host key verification.
  They ship with Linux and macOS. On Windows they come with the *OpenSSH Client*
  optional feature, which is present by default on Windows 10 1809 and later.

No `sshpass` and no external `ssh` binary are required: terminals run over the
extension's own SSH connection.

## Tunnels

A tunnel forwards a port over an existing SSH connection. Use the plug button on
a connected host, then answer four questions.

The destination host is the one that trips people up: it is resolved by the
machine at the *far* end of the tunnel, not by the machine you are sitting at.
To reach a port on the server itself, the answer is `localhost`.

**Reach the remote host's SSH port on local port 2223:**

| Question | Answer |
| --- | --- |
| Kind | Local forward |
| Interface | Localhost only |
| Port to open on this machine | `2223` |
| Where should the traffic end up | the server itself (`localhost`) |
| Port | `22` |

Equivalent to `ssh -L 127.0.0.1:2223:localhost:22`, so `ssh -p 2223 user@127.0.0.1`
reaches the remote host.

**Reach a database the server can see, on local port 5432:** the same, but choose
*Another host* and enter `db.internal`.

**Remote forward** (`-R`) reverses it: a port opened on the server reaches a host
your machine can see. The server needs `AllowTcpForwarding yes`, plus
`GatewayPorts yes` to bind anything other than its own localhost.

## Hosts behind a bastion

A host reached through a jump server is configured the way `ssh` configures it:

```
Host db
  HostName 10.0.0.5
  ProxyJump jump@bastion.example.com
```

Set it when adding a connection, with **Edit Connection...** on an existing
one, or by writing it in `~/.ssh/config` directly. Connecting then asks for
each hop's credentials in turn, and every prompt names the account it is for
and where the chain is going, so the jump host cannot be mistaken for the
destination. Each hop is a real SSH connection carried inside the previous one, so no
external `ssh` process is involved. Chains of several hops work, and each hop
can have its own `Host` block for its user, port and key. Because a jumped host
cannot be reached by `ssh-keyscan`, its host key is checked during the
handshake instead: an unknown key is recorded, and a changed one stops the
connection until you accept it.

A `ProxyCommand` is honoured when it is a jump written the long way
(`ssh -W %h:%p bastion`, or the older `ssh bastion nc %h %p`). Anything else is
reported rather than run.

## Port forwards from ssh_config

`LocalForward` and `RemoteForward` entries open as tunnels when the host
connects, as `ssh` opens them, and appear in the tree where they can be stopped
and restarted.

## Reading ssh_config

The host list is your `~/.ssh/config`, read the way `ssh` reads it:
`Include` directives are followed, globs and all, and a leading `~` in a path
is expanded. A host defined in an included file is written back to that file,
not copied into the main config. A block that itself contains an `Include` is
left alone by the editor, since rewriting it would drop that line.

## Extension Settings

This extension contributes the following settings:

### Keeping the tree and the terminal together

The two directions are separate settings, both off by default, and both can be on at
once -- they will not chase each other.

* `sshMultiConnect.followPathInTerminal` (default `false`): **tree to terminal**.
  Selecting a folder in **Remote Files** types a `cd` into that connection's terminal,
  exactly as if you had typed it, and only when the folder actually changes. Selecting
  a file uses the folder holding it.

  Because it is typed, it goes wherever that terminal's input goes: if a program is
  running there -- an editor, `top`, `less` -- or a command is half typed, the `cd`
  lands in that instead. It reaches the connection's own terminal, not the split group
  the multi-command panel opens. Every shell understands `cd`, so this one works on
  all of them.

* `sshMultiConnect.followTerminalDirectory` (default `false`): **terminal to tree**.
  Every terminal opened from then on runs one setup line as it starts, which makes the
  shell report its folder before each prompt; the tree then follows. You will see that
  line in the terminal, and the shell carries an extra function on `PROMPT_COMMAND`
  (bash) or in `precmd_functions` (zsh) until it exits. Terminals already open are not
  touched -- reopen one to have it report.

  The tree follows any change the shell reports, including one made by a script, by
  `pushd`, or by a `cd` inside a command you ran. **Only bash and zsh can report**:
  on dash, ash, fish, csh and anything else the setup line does nothing at all,
  silently, and the tree will not follow.

* `sshMultiConnect.splitTerminalsForMultiCommand` (default `true`): send a
  multi-host command to a split terminal group, one pane per selected host, so every
  host's output is visible at once. These are terminals the panel opens itself, a
  second shell on each connection; closing one does not disconnect the host. Turn it
  off to send to each connection's own terminal instead.

* `sshMultiConnect.autoReconnect` (default `true`): rebuild a connection that
  drops, without asking for its password again. Suspending the machine is the usual
  cause: the link is gone, but nothing notices until something writes to it, so the
  host sits there looking connected. Reconnection reuses the credentials already held
  for this session and reopens the tunnels that were running; a host whose password
  was never typed this session is left alone rather than prompting at an unattended
  screen.

* `sshMultiConnect.keepaliveInterval` (default `30`): seconds between keepalive
  probes on connections whose `ssh_config` entry does not set `ServerAliveInterval`.
  Three missed probes end the connection, so the default notices a drop in about 90
  seconds. 0 disables probing.

* `sshMultiConnect.savePasswords` (default `false`): keep the passwords you type in
  the operating system's keychain, so a host does not ask again. While it is off, a
  password is only held in memory for the life of the connection. **Forget Saved
  Password** on a connection discards one.

## Known Issues

- Owner and group *names*, and folder sizes, need a POSIX remote host: they read
  `/etc/passwd` and `/etc/group` and run `du`. On other servers the File Details
  panel falls back to raw uid/gid and reports the size as unavailable, rather
  than failing.
- Changing owner or group normally requires root on the remote host. When it is
  refused, the mode change is still applied and reported separately.

## Release Notes

Below some last release note, for more details see the CHANGELOG.md

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