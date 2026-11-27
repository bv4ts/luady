# Security notes

What the hub assumes, what it protects, and how to reach it from elsewhere.

## One Unix user per machine

The hub, its website and its sessions run as one Unix user, and that user is the owner. Nobody else should have an
account on the machine, or at least none that you do not trust with everything below.

- The process starts with `umask 077`. The folders it owns (`dataDir`, `brainDir`, `runDir`, the manager's home,
  `<dataDir>/addons` and `<dataDir>/outbox`) are created at mode 0700. The database (with its `-wal` and `-shm` files),
  `secrets.env`, the fleet key, `hub-token` and the add-on tokens are 0600. A wider mode found at start is tightened,
  with a warning in the log.
- The hub refuses to start when one of those folders or files belongs to another Unix user. `config.json` (it names the
  programs the hub runs) and the folders of the config and of the secrets must belong to you or to root: yours lose
  group and other write at start, root's must not be writable by anyone else, and any other user's refuses the start,
  whatever its mode.
- On Windows there are no Unix modes. The hub logs one warning and enforces none of the above: run it on Linux or in
  WSL2.
- `SESSION_SECRET` and `HUB_SOCKET_TOKEN` are generated on the first start and never overwritten. `SESSION_SECRET` also
  seals stored tokens (Google, Wispr, Jira). If the secrets file does not open them, the hub refuses to start with
  "this secrets file does not belong to this database": point `LUADY_SECRETS` at the right file. Never delete it on a
  working install.
- Anyone who can read the data folder can read the fleet key and the database. That is why the folder is the owner's
  alone; the database adds no new exposure beside the key.
- Sign-in attempts are limited to 10 a minute per client address (the passkey and PIN routes and the login link). On a
  local install every program on the hub machine reaches the hub from the same loopback address, so they all share that
  one limit: a program that keeps calling the sign-in routes can hold your own sign-in at "too many attempts" for as
  long as it runs. The limit stays as it is, because a weaker one would help a program guess faster; under the one-user
  assumption such a program is already running as you. The sign-in pages say when the limit is reached and how long to
  wait (at most a minute); if it keeps coming back, look for the program that is calling the hub.

## The page key

Browsers scope cookies by host name, not by port. A session cookie for `localhost` is therefore also sent to every
other web server on `localhost`, whatever its port: a development server, a tool you are trying out. Such a server could
replay the cookie.

The page key closes that gap:

- A sign-in (a passkey, a login link, the claim) answers with a random page key. The hub stores only its SHA-256.
- The website keeps the key in this origin's storage, which, unlike the cookie, is scoped by port.
- Every `/api` request must carry the key in `x-hub-key`, reads included. Without it the hub answers 401
  `page_key_required` and the website asks you to sign in again. `/api/me` never returns the key.
- A WebSocket must send `{ "type": "auth", "key": … }` as its first message. Until then it receives nothing at all,
  not even `hello`, and it does not count as "you are on the website". Without a valid key within 5 seconds it is
  closed with code 4401.
- The terminal socket (`/ws/terminal`) takes a single-use ticket in its address instead. Getting one
  (`POST /api/terminal/open`) needs the page key and your PIN (unless you switched off **Ask for my PIN before the
  manager's risky actions**, which itself needs the PIN). A ticket is valid for 60 seconds and opens one socket, only for
  the signed-in session that asked for it: with another session's cookie it is refused (4401) and spent. The ticket
  takes the place of the first-message auth.
- The key rotates with the session. A browser that clears its storage signs in again; that is intended.

## The Host check

The web server answers only to the Host names in `allowedHosts` (by default the `host:port` of `publicOrigin`, so
`localhost:7410`). Any other Host, `127.0.0.1:7410` included, gets 421 "Open `<publicOrigin>`". This blunts DNS rebinding:
a page on another domain that resolves to the hub machine cannot talk to the hub.

## What "remote" means

An install is **remote** when `bindHost` is not a loopback address, **or** the host of `publicOrigin` is not
`localhost`, **or** an `allowedHosts` entry names a host other than `localhost`. A hub bound to `127.0.0.1` behind a
tunnel or a reverse proxy that serves `https://hub.example` is remote. A hub you reach through an SSH tunnel as
`http://localhost` is not.

A remote install needs all of:

- `"allowRemote": true` in `config.json`;
- an `https` `publicOrigin`;
- at least one passkey (in `cloudflare-access` mode, Cloudflare Access is the outer gate and the setup code still
  guards the first passkey, so this one is waived).

Otherwise the hub refuses to start. On a remote install the passkey-less login link and the passkey skip are refused.
The login link is also refused whenever a forwarding header is present (`Forwarded`, `Via`, any `X-Forwarded-*`,
`X-Real-IP`, `X-Client-IP`, `CF-Connecting-IP`, `True-Client-IP`, `Fly-Client-IP`) or the TCP peer is not loopback. An
SSH tunnel adds no header and arrives from loopback, so the link works through one.

`CF-Connecting-IP` is trusted for rate limits only with `"trustedProxy": "cloudflare"` and only from a loopback peer
(cloudflared runs on the same machine). A direct connection can never choose its own bucket. If you run a remote
install behind cloudflared yourself, set `"trustedProxy": "cloudflare"`; otherwise every visitor shares one rate
bucket. Never set it behind any other proxy, which would pass a client's own header through.

HSTS is sent only for an `https` origin whose host is not `localhost`: on `https://localhost` it would pin every local
port for a year. The session cookie is always `Secure`, `HttpOnly` and `SameSite=Strict`.

## Reaching the hub from another machine: the SSH tunnel

In this release the only supported remote recipe is an SSH tunnel. The hub stays local (loopback, `http://localhost`),
and your laptop reaches it as if it were local:

```sh
ssh -N -L 7410:127.0.0.1:7410 dev@oak.example.invalid
```

Then open `http://localhost:7410` on the laptop. Passkeys, the `Secure` cookie and the page key all work, because the
origin is `localhost`. Nothing listens on a public address. Generic reverse-proxy setups are not supported yet.

## The manager

The manager is off on a new install. Switched on, it runs Claude Code under its own home folder (`managerHome`), with
its own kit, its own Claude sign-in and its own tmux server, so its sessions and spool never mix with yours. With the
default `"managerFiles": "own-folder"` its file tools may read and change files only inside its own folder (`brainDir`),
and in either mode never its own configuration (`brainDir/.manager/`: its settings, its MCP config and its prompt
hook), which the hub writes again before every launch, nor a project config in its folder (`brainDir/.claude/`,
`brainDir/.mcp.json`). It is launched with only its user settings and the rendered file (`--setting-sources user`), so
project and local settings in its folder are never read.
The hub's tools are not bound by that folder: through them it reads files on your servers and on this computer, starts,
steers and stops sessions, and runs commands, with your PIN for the risky ones; [The manager](manager.md#what-it-can-do)
lists which need it. On this computer the hub's file verbs refuse the hub's own folders (config, secrets, data and run
folders, the manager's home and its `.manager/` settings, the hub token, the fleet key), `~/.codex` and the `.codex`
folder beside the data folder to every caller, and refuse writes into the local kit (`~/.luady`) and the folder Luady
is installed in, after resolving `~`, `..` and symlinks. It reads mail and calendar only if you connect them. It uses
your Claude plan.

## What an add-on is trusted with

An add-on runs as the hub's Unix user, so it can read `secrets.env`, the fleet key and the database. **Its token is
identity, not isolation.** A channel add-on speaks as the owner, and sees any PIN the owner types in chat. Tool
descriptions and `brainNotes` become prompt text for the manager. **Install only add-ons you would run as yourself.**

What the hub does limit. An add-on's token opens only its own socket (`/internal/addon/<id>`); every other internal
route refuses it. A file it hands over must sit in its own `files` folder, and is copied into the outbox within a size
and count limit. It may deliver one message at a time and a few per minute. Text and captions it delivers start with
its name, so they never read as the hub's own. A tool name that is already taken is refused, and the manager's tool
list names the add-on behind each tool. Panels show text only.
