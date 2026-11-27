# Troubleshooting and doctor

Start with `doctor`. It checks the install and says, for each problem, how to fix it.

## The doctor command

```sh
npm run doctor
```

Run it from the repository folder, after `npm run build`. Each line is **PASS**, **WARN** or **FAIL**, and every WARN
and FAIL has a `Fix:` line under it. The report ends with the counts. It checks:

- the hub machine: Node.js 22.12 or newer, the platform (Linux; a warning on Windows and macOS), tmux, Python 3.10 or
  newer, Claude Code at the configured path, the website build and the web port;
- the install: the config file and the start rules below, the modes of the secrets file and the hub's folders, the
  database and its migrations, your time zone, the setup wizard and the fleet key;
- the running hub: your servers (how many are online, not online or without the kit, and whether one refused the hub),
  each add-on, and the manager's setup when the manager is on.

The hub, servers, add-ons and manager can be checked only while the hub runs. When it does not, doctor says so with a
WARN and checks the rest.

By default doctor prints only states and counts, so you can paste it into a bug report. `--full` adds the names,
addresses and paths behind each line (for a server: its link, last error, kit version and the name the kit was installed
for). It never prints your secrets, your phone number or your e-mail. `--json` prints the same as JSON:

```sh
npm run doctor -- --json
```

`npm run doctor -- --full --json` combines the two. The exit code is 0 when nothing FAILs and 1 when something does, so
scripts can use it.

## The hub does not start

The hub prints one plain line when it refuses to start. The most common ones:

| The line starts with | What to do |
|---|---|
| `Refusing to start: this install counts as remote` | Keep `bindHost` at `127.0.0.1` and `publicOrigin` on `localhost`, or see [Security](security.md#reaching-the-hub-from-another-machine). |
| `Refusing to start: a remote install needs an https publicOrigin` | A remote `publicOrigin` must be `https`. |
| `Refusing to start: a remote install needs at least one passkey` | Add a passkey from `localhost` first. |
| `Refusing to start: two hosts share the id` or `Refusing to start: the host id "…" is reserved` | Rename one in `config.json`. |
| `Refusing to start: this secrets file does not belong to this database` | Point `LUADY_SECRETS` at the secrets file that came with this database. Never make a new one for an existing install. |
| `Refusing to start: … belongs to another Unix user` | The hub's folders and files must belong to the user that runs it. Fix the owner (`chown`), then start again. |

If the port is taken, set another `webPort` in `~/.config/luady/config.json`.

## The page says "Open http://localhost:7410"

The hub answers only to the address in its config, `localhost` by default. Open `http://localhost:7410`, not
`http://127.0.0.1:7410`.

## The website asks me to sign in again

That is expected after you clear the browser's storage or open the hub on another port: the page key that goes with
your session is kept per browser and per port. Sign in again with your passkey, or with a new login link
(`npm run luady -- login`).

## I forgot my PIN

On the hub machine:

```sh
npm run luady -- pin reset
```

It asks you to type `yes`, clears the PIN, signs every browser out and ends every setup code and login link not used
yet. Your passkeys stay. Setting a new PIN needs a signed-in browser and a setup code. Sign in again with your passkey,
then print a code and enter it when the page asks for a new PIN:

```sh
npm run luady -- setup-code
```

Without a passkey on this device, run `npm run luady -- login` instead. It prints a login link and a setup code
together: use that code. Only the newest setup code works, so a code printed before `login` is refused.

## The setup code ran out

A setup code works once, for 30 minutes, and a new code ends the one before it. Print a new one with
`npm run luady -- setup-code`.

## A server says it cannot connect

### Unreachable

Nothing answered. Check that the server is on, the address and port, and any firewall.

### Denied

It answered but refused the hub's key. Paste the key line again as the right user, then press **Try again**. The hub
stops retrying until you do.

### Fingerprint changed

The server's host key is not the one you trusted, and the hub stops connecting. Find out why before anything else.

- If the change is expected (a reinstall) and you added the server on the website: remove it (keep its rooms), add it
  again under a new name, compare the new fingerprint, then give the kept room the new server.
- For a server from `config.json`: put the new fingerprint in its `hostKeyFp` and restart the hub.

## A session does not show up

- Is the kit installed on that machine? **Settings → Servers** shows it.
- Does the session run inside tmux? The kit finds Claude Code only in tmux panes.
- Was it already running when the kit was installed? Sessions already running appear after the hub restarts; a session
  you start from then on appears at once.
- Is it in a room? A session that matches no room is "Not on the map": add a room for its server, or a project room
  that matches it. See [How a session finds its room](rooms.md#how-a-session-finds-its-room).

## `npm ci` fails while building a native module

The hub's two native modules, `better-sqlite3` (the database) and `argon2` (the PIN), come with ready-made builds for
common Linux machines. Elsewhere npm compiles them and needs C and C++ build tools and Python:
`sudo apt install build-essential python3` on Debian and Ubuntu.

## Windows

Run the hub inside WSL2, not in Windows itself: the hub relies on Unix file modes and a Unix socket. The demo
(`npm run demo`) is the one part meant to run on Windows directly. In Windows PowerShell, quote the two dashes before
the demo's options: `npm run demo '--' --rooms 24`.

## Where the hub logs

The hub logs to its terminal. As a service, read the log with `journalctl --user -u luady.service`. For more detail,
start it with `LOG_LEVEL=debug npm start`.

## Still stuck?

Search the [issues](https://github.com/bv4ts/luady/issues), or open one with what `npm run doctor` printed. By default it
shows only states and counts, with no names, addresses or paths. `npm run doctor -- --full` adds them: remove the
private parts before you share that.
