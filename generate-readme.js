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
- Organize SSH connections into folders, with drag and drop.
- Execute commands on multiple hosts simultaneously.
- Open local and remote SSH tunnels, with start/stop control and live state.
- Inspect remote files and folders, and edit their permissions and ownership.
- Create, rename and delete remote files and folders from the right-click menu.
- Retry an operation with sudo when the remote user lacks permission.
- Run one command across hosts and read the collected output in one report.
- Keep a tunnel in \`ssh_config\` so it opens on every connect.
- Reach hosts behind a bastion, with \`ProxyJump\`, set from the connection's right-click menu.
- Connect from the command palette with **Connect to SSH Host...**.
- Runs on Windows, macOS and Linux.

## Requirements

- Visual Studio Code version 1.96.0 or higher.
- The OpenSSH command-line tools (\`ssh-keygen\`, \`ssh-keyscan\`) on your PATH, used for host key verification.
  They ship with Linux and macOS. On Windows they come with the *OpenSSH Client*
  optional feature, which is present by default on Windows 10 1809 and later.

No \`sshpass\` and no external \`ssh\` binary are required: terminals run over the
extension's own SSH connection.

## Tunnels

A tunnel forwards a port over an existing SSH connection. Use the plug button on
a connected host, then answer four questions.

The destination host is the one that trips people up: it is resolved by the
machine at the *far* end of the tunnel, not by the machine you are sitting at.
To reach a port on the server itself, the answer is \`localhost\`.

**Reach the remote host's SSH port on local port 2223:**

| Question | Answer |
| --- | --- |
| Kind | Local forward |
| Interface | Localhost only |
| Port to open on this machine | \`2223\` |
| Where should the traffic end up | the server itself (\`localhost\`) |
| Port | \`22\` |

Equivalent to \`ssh -L 127.0.0.1:2223:localhost:22\`, so \`ssh -p 2223 user@127.0.0.1\`
reaches the remote host.

**Reach a database the server can see, on local port 5432:** the same, but choose
*Another host* and enter \`db.internal\`.

**Remote forward** (\`-R\`) reverses it: a port opened on the server reaches a host
your machine can see. The server needs \`AllowTcpForwarding yes\`, plus
\`GatewayPorts yes\` to bind anything other than its own localhost.

## Hosts behind a bastion

A host reached through a jump server is configured the way \`ssh\` configures it:

\`\`\`
Host db
  HostName 10.0.0.5
  ProxyJump jump@bastion.example.com
\`\`\`

Set it when adding a connection, with **Edit Connection...** on an existing
one, or by writing it in \`~/.ssh/config\` directly. Connecting then asks for
each hop's credentials in turn, and every prompt names the account it is for
and where the chain is going, so the jump host cannot be mistaken for the
destination. Each hop is a real SSH connection carried inside the previous one, so no
external \`ssh\` process is involved. Chains of several hops work, and each hop
can have its own \`Host\` block for its user, port and key. Because a jumped host
cannot be reached by \`ssh-keyscan\`, its host key is checked during the
handshake instead: an unknown key is recorded, and a changed one stops the
connection until you accept it.

A \`ProxyCommand\` is honoured when it is a jump written the long way
(\`ssh -W %h:%p bastion\`, or the older \`ssh bastion nc %h %p\`). Anything else is
reported rather than run.

## Port forwards from ssh_config

\`LocalForward\` and \`RemoteForward\` entries open as tunnels when the host
connects, as \`ssh\` opens them, and appear in the tree where they can be stopped
and restarted.

## Reading ssh_config

The host list is your \`~/.ssh/config\`, read the way \`ssh\` reads it:
\`Include\` directives are followed, globs and all, and a leading \`~\` in a path
is expanded. A host defined in an included file is written back to that file,
not copied into the main config. A block that itself contains an \`Include\` is
left alone by the editor, since rewriting it would drop that line.

## Extension Settings

This extension contributes the following settings:

* \`sshMultiConnect.followPathInTerminal\` (default \`false\`): change the connection's
  terminal to the directory you select in **Remote Files**. Selecting a file uses its
  parent folder. The \`cd\` is typed into the terminal, so it can disturb a command that
  is already running there; it is only sent when the directory actually changes.

* \`sshMultiConnect.splitTerminalsForMultiCommand\` (default \`true\`): send a
  multi-host command to a split terminal group, one pane per selected host, so every
  host's output is visible at once. These are terminals the panel opens itself, a
  second shell on each connection; closing one does not disconnect the host. Turn it
  off to send to each connection's own terminal instead.

* \`sshMultiConnect.autoReconnect\` (default \`true\`): rebuild a connection that
  drops, without asking for its password again. Suspending the machine is the usual
  cause: the link is gone, but nothing notices until something writes to it, so the
  host sits there looking connected. Reconnection reuses the credentials already held
  for this session and reopens the tunnels that were running; a host whose password
  was never typed this session is left alone rather than prompting at an unattended
  screen.

* \`sshMultiConnect.keepaliveInterval\` (default \`30\`): seconds between keepalive
  probes on connections whose \`ssh_config\` entry does not set \`ServerAliveInterval\`.
  Three missed probes end the connection, so the default notices a drop in about 90
  seconds. 0 disables probing.

* \`sshMultiConnect.savePasswords\` (default \`false\`): keep the passwords you type in
  the operating system's keychain, so a host does not ask again. While it is off, a
  password is only held in memory for the life of the connection. **Forget Saved
  Password** on a connection discards one.

## Known Issues

- Owner and group *names*, and folder sizes, need a POSIX remote host: they read
  \`/etc/passwd\` and \`/etc/group\` and run \`du\`. On other servers the File Details
  panel falls back to raw uid/gid and reports the size as unavailable, rather
  than failing.
- Changing owner or group normally requires root on the remote host. When it is
  refused, the mode change is still applied and reported separately.

## Release Notes

Below some last release note, for more details see the CHANGELOG.md

${limitedReleaseNotes}

`;

fs.writeFileSync(path.join(__dirname, 'README.md'), readmeContent.trim());
console.log('README.md generated successfully.');
