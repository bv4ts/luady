# Getting started

There are three ways to meet Luady, from no install at all to the real thing.

1. **The live demo** in your browser: the office page against a pretend hub that lives in the page. Nothing to install.
   Open it at <https://www.baraaalshugri.info/luady/demo/>. It is only the office page: there is no sign-in, no setup and no
   server list, and the rooms you add or change are gone when you reload.
2. **The demo on your computer**: the real hub with a pretend fleet. Nothing real is contacted.
3. **The real install**: the hub on one machine, your servers added from the website.

For a numbered walk-through of the real install on a fresh machine, see the
[quickstart](quickstart.md).

## Try the demo

You need [Node.js](https://nodejs.org/) 22.12 or newer and Git. The demo runs on Windows and Linux. It has not been
tried on macOS yet.

```sh
git clone https://github.com/bv4ts/luady.git
cd luady
npm ci
npm run demo
```

`npm ci` installs two native modules; see [What you need](#what-you-need) if they have to compile. The first
`npm run demo` builds what it needs. Then it prints a login link: open it in Chrome or Firefox. The link signs one
browser in once, and the demo then prints the next one. When the demo asks for a PIN, it is `123456`. Every server in
the demo is pretend (their addresses end in `.invalid`), and no add-on is attached. Stop it with
<kbd>Ctrl</kbd>+<kbd>C</kbd>; it removes its data when it stops. It refuses to start when `NODE_ENV` is `production`
or when `LUADY_CONFIG` or `LUADY_SECRETS` is set, so it cannot be mistaken for a real install.

The options of the demo (the number of rooms, a still office, a fixed clock) and the note for Windows PowerShell are in
the [quickstart](quickstart.md#demo-options).

## Run it for real

### What you need

| Where | What |
|---|---|
| The hub machine | Linux, or Windows with WSL2. Node.js 22.12 or newer, Git. |
| This computer, if its own Claude Code sessions should show | tmux, Python 3.10 or newer and Claude Code, on the same machine as the hub. |
| Each server | Linux, reachable over SSH from the hub. Python 3.10 or newer, tmux, tar, mktemp and Claude Code, and a user the hub signs in as. |
| Claude Code | Any version runs; the recent steps in a session's panel need 2.1.295 or newer. |
| Your browser | A current desktop browser; for passkeys, one that supports them (Chrome, Edge or Firefox). |

The office view needs WebGL; without it Luady shows its Classic view.

The hub uses two native modules: `better-sqlite3` for its database and `argon2` for the PIN. `npm ci` downloads
ready-made builds for common Linux machines; on others it compiles them, and then needs your system's C and C++ build
tools and Python (`sudo apt install build-essential python3` on Debian and Ubuntu).

**On a Mac.** The hub does not run on macOS in this version, and the demo has not been tried there. Run the hub on a
Linux machine you reach over SSH (a server or a Linux virtual machine) and open it from the Mac through an SSH tunnel
(see [Reaching the hub from another machine](security.md#reaching-the-hub-from-another-machine)). That Linux machine's
sessions show as this computer; the Mac's own sessions cannot be shown.

### Install and start

```sh
git clone https://github.com/bv4ts/luady.git
cd luady
npm ci
npm run build
npm start
```

`npm start` is short for `npm run luady -- start`, so it needs the build first.

On the first start the hub writes a starter config, makes its secrets, and prints a **setup code** in the terminal.
Started where its output is not a terminal (a systemd service, whose output goes to the journal), it prints no code,
only how to get one: run `npm run luady -- setup-code` in a terminal.
Then open <http://localhost:7410> in a browser on the hub machine. The [setup wizard](setup-wizard.md) takes it from
there: claim the hub with the setup code, choose a PIN, add this computer or a server, make rooms, and choose the extras.

Until the hub is claimed, every start in a terminal prints a new setup code. Only one code works at a time: a new one
ends the one before it. A code works for 30 minutes.

The hub listens on `127.0.0.1` only. To use it from another machine, see
[Reaching the hub from another machine](security.md#reaching-the-hub-from-another-machine).

### Keep it running

`npm start` runs in the foreground. Keep it in a terminal you do not close, in tmux, or under your system's service
manager (the [quickstart](quickstart.md) shows a systemd user service). Stop it with <kbd>Ctrl</kbd>+<kbd>C</kbd>.

### Update

There is no update button yet. To update:

1. Stop the hub (<kbd>Ctrl</kbd>+<kbd>C</kbd>, or `systemctl --user stop luady.service`).
2. In the clone: `git pull`, `npm ci`, `npm run build`.
3. Start it again (`npm start`, or `systemctl --user start luady.service`). The first start updates the database.
4. In **Settings → Servers**, press **Update kit** for each server and for this computer, so that every kit matches
   the hub.

## Where your data lives

| What | Where |
|---|---|
| Settings file | `~/.config/luady/config.json` |
| Secrets (generated, never overwritten) | `~/.config/luady/secrets.env` |
| Database, fleet key, add-on tokens, the manager's own home | `~/.local/share/luady/data/` |
| The manager's folder | `~/.local/share/luady/brain/` |
| The hub's socket | `~/.local/share/luady/run/` |

The folders follow `XDG_CONFIG_HOME` and `XDG_DATA_HOME` when you set them. `LUADY_CONFIG` and `LUADY_SECRETS` point
the hub at another settings or secrets file. Keep `secrets.env` with its database: it seals the tokens stored there.

### Back up and restore

By default everything the hub keeps is in two folders: `~/.config/luady/` (the settings and `secrets.env`) and
`~/.local/share/luady/` (the database, the fleet key, add-on tokens and the manager's folders). To back up, stop the hub
and copy both folders; keep the copy private, since it holds the fleet key and the secrets. To restore, stop the hub,
put both folders back for the same Unix user, and start it. Always restore `secrets.env` with the database from the same
moment: it seals the tokens stored there, and the hub refuses to start with a secrets file that does not belong to its
database. Your servers need nothing from the backup.

## Next

- [The setup wizard](setup-wizard.md), step by step.
- [The command line](quickstart.md#the-command-line): `start`, `setup-code`, `login`, `pin reset` and `doctor`.
- [Adding servers](servers.md): what a server needs, and what the hub does to it.
- [Security](security.md): what is protected, and how.
