# Quickstart

Luady is a self-hosted website for your Claude Code sessions: every session on your computer and your servers sits at a
desk in a small pixel-art office. This page takes you from nothing to a running hub. It has three parts: try the demo
(Linux or Windows; not yet tried on macOS), install the hub (Linux or WSL2), and add your servers.

## 1. Try the demo

The demo is the real hub and website with everything outside faked: no server, no SSH, no Claude Code, nothing leaves
your machine. It runs on Linux and Windows.

You need [Node.js](https://nodejs.org/) 22.12 or newer (with npm) and Git.

```sh
git clone https://github.com/bv4ts/luady.git
cd luady
npm ci
npm run demo
```

The first `npm run demo` builds everything, which takes a minute or two. Then it prints a login link and the demo PIN
(`123456`). Open the link in Chrome or Firefox. The link signs one browser in once; the demo then prints the next one.
Stop the demo with <kbd>Ctrl</kbd>+<kbd>C</kbd>; it removes its data on exit.

`npm ci` installs two native modules, `better-sqlite3` (the database) and `argon2` (the PIN), which ship ready-built
for common systems. On a system without a ready-built copy (a slim container, an unusual CPU) npm compiles them and
needs build tools: on Debian or Ubuntu `sudo apt install build-essential python3`; on Windows, the "Desktop development
with C++" workload of the Visual Studio Build Tools.

### Demo options

| Option | What it does |
|---|---|
| `--rooms classic` | The default: four rooms with their sessions, a board, notes and a Jira site |
| `--rooms <n>` | An office of n rooms, 0 to 1000 (0 is empty). Each room has 0 to 3 sessions |
| `--rooms mixed` | 12 rooms on 6 servers |
| `--still` | Nothing moves unless you drive it |
| `--loop` | The default: a session changes every 4 seconds |
| `--clock <ISO time>` | Fix the office clock, for daylight and lamps (for example `2030-01-15T18:30:00Z`), in a fixed time zone. Without it the demo uses this machine's clock and time zone |
| `--port <n>` | Another port (default 7420) |
| `--keep <folder>` | Keep the demo's data in this folder between runs (a new or empty folder, or one the demo made before: it refuses any other) |
| `--open` | Open the login link in your browser |

On Linux, Git Bash or the Windows Command Prompt, put the options after `--`:

```sh
npm run demo -- --rooms 24 --still
```

**Windows PowerShell** drops a bare `--` (npm then takes the options as its own and warns "Unknown cli config"). There,
quote it, or run the demo with Node directly, from the `luady` folder:

```powershell
npm run demo '--' --rooms 24 --still
node --experimental-strip-types preview/demo.ts --rooms 24 --still
```

## 2. Install the hub

The hub runs on **Linux, or in WSL2 on Windows** (Ubuntu is what we test). It does not run natively on Windows: on
Windows itself, use the demo above, or install WSL2 (`wsl --install` in an administrator PowerShell) and follow this
section inside it, in your Linux home folder (`cd ~`), not under `/mnt/c`, where files are slow.

Run the hub as your own user, on the machine whose sessions you want to see first (see
[One Unix user per machine](#one-unix-user-per-machine)).

1. Install what the hub needs. On Debian or Ubuntu:

   ```sh
   sudo apt update
   sudo apt install git tmux python3 build-essential
   ```

   Plus Node.js 22.12 or newer. The `nodejs` package of Ubuntu 24.04 and older is too old: install
   [nvm](https://github.com/nvm-sh/nvm) as its page shows, then run `nvm install 22` (and see step 5 if you use the
   service). `tmux`,
   Python 3.10 or newer and [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) are needed only if this
   machine will run sessions itself ("this computer") or the manager.

2. Get the code and build it:

   ```sh
   git clone https://github.com/bv4ts/luady.git ~/luady
   cd ~/luady
   npm ci
   npm run build
   ```

3. Start it:

   ```sh
   npm start
   ```

   The first start writes `~/.config/luady/config.json` and `~/.config/luady/secrets.env`, makes the data folder
   (`~/.local/share/luady/`) and prints:

   ```text
   Luady is running: open http://localhost:7410 in your browser.
   To claim this install, enter this code on the page.
   Setup code: ABCD-EFGH-JKLM
   It works once and expires in 30 minutes (at 14:32).
   No passkey on this device? Run npm run luady -- login instead.
   ```

   Only one setup code works at a time: a new one ends the one before it. New codes come from
   `npm run luady -- setup-code`, from `npm run luady -- login` while no PIN is set, and from each start in a terminal
   of a hub nobody has claimed yet.

4. Open `http://localhost:7410` on the hub machine (from WSL2, in your Windows browser). The setup wizard has six steps:

   1. **Claim.** Type the setup code and create a passkey (Windows Hello, Touch ID, a phone or a security key). No
      passkey on this device? Run `npm run luady -- login` in a second terminal: it prints a login link (it works for
      5 minutes, from the hub machine or through an SSH tunnel to it) with a new setup code, and after that sign-in you
      can skip the passkey (local installs only).
   2. **PIN.** Choose the PIN that confirms risky actions (stopping a session, adding or removing a server, writing a
      file or running a command on a server, opening a terminal). Starting a session and sending it a message need no
      PIN; a started session runs with permissions bypassed (see [Add your servers](#3-add-your-servers)). The first PIN
      needs the setup code.
   3. **Rooms.** "Add this computer" (its projects folder, which it can create for you), "Add a server" (see
      [Add your servers](#3-add-your-servers)), and rooms for projects. You can skip this and do it later in
      Settings.
   4. **Connect.** Install the kit (a small Python program) on each computer and server, and sign each one in to
      Claude.
   5. **Extras.** The manager (off by default; once on, it acts with the rights of the user on each of your machines,
      and your PIN brakes only its risky actions: see [The manager](manager.md#what-it-can-do)) and add-ons.
   6. **Open the office.**

5. Keep it running after you close the terminal, as a systemd user service. First stop the hub from step 3 with
   <kbd>Ctrl</kbd>+<kbd>C</kbd>: the service needs its port.

   ```sh
   mkdir -p ~/.config/systemd/user
   cp deploy/systemd/luady.user.service ~/.config/systemd/user/luady.service
   systemctl --user daemon-reload
   systemctl --user enable --now luady.service
   # optional: keep it running while you are logged out
   loginctl enable-linger "$USER"
   ```

   The unit expects the clone at `~/luady` (its `WorkingDirectory=` line) and looks for Node.js only in the folders of
   its `Environment=PATH=` line. Node.js from nvm is not in them: put the folder that `dirname "$(command -v node)"`
   prints at the front of that line in `~/.config/systemd/user/luady.service`, then run
   `systemctl --user daemon-reload` and `systemctl --user restart luady.service`. Its log:
   `journalctl --user -u luady.service`. Its output is not a terminal, so a start under systemd prints no setup code;
   run `npm run luady -- setup-code` in a terminal for one. In WSL2, systemd must be on (`[boot] systemd=true` in
   `/etc/wsl.conf`); after changing that file, run `wsl --shutdown` in Windows and open Ubuntu again.

### The command line

Run these from the clone, after `npm run build`. Every command is `npm run luady -- <command>`; `npm start` and
`npm run doctor` are short for `npm run luady -- start` and `npm run luady -- doctor`. Everything except `npm start`
works whether or not the hub is running.

- `npm start`: starts the hub. On a hub nobody has claimed yet, it prints a setup code (in a terminal; under a service
  manager, how to get one).
- `npm run luady -- setup-code`: prints a new one-time setup code, valid for 30 minutes. A new code ends the earlier one.
- `npm run luady -- login`: prints a login link. It works once, for 5 minutes, in a browser on the hub machine or at
  the other end of an SSH tunnel to it. While no PIN is set it also prints a setup code. Refused on a remote install.
- `npm run luady -- pin reset`: asks you to type `yes`, then clears your PIN and signs every browser out. Your passkeys
  stay. The next PIN needs a new setup code (see [Forgot your PIN](#forgot-your-pin)).
- `npm run doctor`: checks the install. Each line is PASS, WARN or FAIL with a fix.

`setup-code`, `login` and `pin reset` work on the install of the user who runs them. Without one (no config, secrets or
database where the hub keeps them, for example under `sudo` or another account) they refuse and create nothing.

`npm run doctor` prints only states and counts, so you can paste it into a bug report as it is.
`npm run doctor -- --full` adds names, addresses and paths: remove the private parts before you share that. `--json`
prints the same as JSON. Its exit code is 0 only when nothing fails.

## 3. Add your servers

Add servers on the website: in the setup's **Rooms** step, or later in **Settings → Servers → Add a server**. The flow
asks for the address, the Unix user and the SSH port, then:

1. Shows **the key line**: the public half of the hub's own SSH key, the fleet key (made on the first start; its private
   half never leaves the hub machine). Append it to `~/.ssh/authorized_keys` of that user on the server; the page has a
   copy button and a one-command way to do it.
2. **Tests the connection.** It reads the server's host key without signing in and shows its fingerprint, with the
   command to compare it on the server. Confirm only when they match:

   ```sh
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

3. **Checks the server**: Python, tmux, tar, mktemp and Claude Code, and whether a kit is there already.
4. **Installs the kit** (`~/.luady/` on the server) once you agree.
5. Gives the server **a room**: name, colour and creature.

Each server needs:

- Linux with an SSH server the hub machine can reach;
- the Unix user whose sessions you want to see, with the key line in its `authorized_keys`;
- Python 3.10 or newer as `python3`, `tmux`, `tar` and `mktemp`;
- Claude Code, by default at `~/.local/bin/claude` (another path can be given);
- a projects folder, by default `~/projects`.

Sessions you start after the kit is installed appear in the office.

> [!WARNING]
> **Sessions run with permissions bypassed.** Each session is Claude Code started with
> `--permission-mode bypassPermissions`: it can read, change and run anything that its Unix user can, without asking.
> Give each server a user that owns only what its sessions should touch, and give a session only work you would let it
> do unattended.

## One Unix user per machine

The hub, its website and its sessions run as one Unix user, and that user is the owner. The hub's folders are 0700 and
its files 0600; it refuses to start when one of them belongs to another user. Do not share the machine with users you
do not trust with everything in the data folder (the fleet key, the database, `secrets.env`). The same holds for each
server: the hub reaches it as one user. More in [Security notes](security-notes.md).

## Reaching the hub from another machine

The only supported way in this release is an **SSH tunnel**. The hub stays on `http://localhost:7410`, and your laptop
reaches it as if it were local:

```sh
ssh -N -L 7410:127.0.0.1:7410 dev@oak.example.invalid
```

Then open `http://localhost:7410` on the laptop. Passkeys and the session cookie keep working, because the address is
still `localhost`. Do not expose the port on a public address. Reverse proxies are not supported yet.

The laptop's browser has no sign-in yet. Run `npm run luady -- login` on the hub machine and open the link it prints on
the laptop: the tunnel arrives from the hub machine itself, so the link is accepted. Then add a passkey for the laptop
in **Settings → Security** (**Add a passkey on this device**). A security key you registered on the hub machine works
on the laptop too.

## Rotate the fleet key

See [The fleet key](servers.md#the-fleet-key).

## Forgot your PIN

On the hub machine, from the clone (the hub may keep running):

```sh
npm run luady -- pin reset
```

Type `yes`. It clears the PIN and its lockout, signs every browser out and ends every unused setup code and login link;
your passkeys stay. Then sign in with your passkey, run `npm run luady -- setup-code` and choose a new PIN with that
code. Without a passkey on this device, run `npm run luady -- login` instead: it prints a login link and the setup code
to use after it (a code printed before it no longer works).

## When something is wrong

Run `npm run doctor` and follow the fix under each WARN or FAIL. With the manager switched off, its checks say
"manager off" and never fail. If you open an issue, paste the default `npm run doctor` output.
