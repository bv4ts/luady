# The config file

The hub reads `~/.config/luady/config.json` (or the file that `LUADY_CONFIG` names). The first start writes a starter
file. Every key is optional, and a key the hub does not know stops it from starting. Paths must be absolute.

The starter file holds `"authMode": "local"`: leave it as it is.

## Keys

- `webPort` (default `7410`): the website's port. The default `publicOrigin` follows it.
- `bindHost` (default `127.0.0.1`): the address the website listens on. Anything but a loopback address makes the
  install remote.
- `publicOrigin` (default `http://localhost:<webPort>`), `allowedHosts` and `allowRemote` (default `false`): see
  [What "remote" means](security-notes.md#what-remote-means).
- `dataDir`, `brainDir` and `runDir` (defaults `~/.local/share/luady/data`, `~/.local/share/luady/brain` and
  `~/.local/share/luady/run`).
- `fleetKeyPath` (default `<dataDir>/fleet_ed25519`): the hub's SSH key for your servers.
- `managerHome` (default `<dataDir>/manager-home`): the manager's own home folder.
- `claudePath` (default `~/.local/bin/claude`): Claude Code on the hub machine.
- `managerFiles` (`own-folder`, the default, or `any`): which files the manager may touch. See
  [The manager](manager.md).
- `servers`: servers the hub is told about at start. See
  [Servers from the config file](servers.md#servers-from-the-config-file).
- `addons`: add-ons the hub accepts. See [Add-ons](addons.md#set-one-up).
- `fleetFrom`: IP addresses or networks (such as `192.0.2.10` or `198.51.100.0/24`) that the key line limits the fleet
  key to, as `from="…"`. A server then accepts the key only from them.

A few more keys exist for setups these docs do not cover (Cloudflare Access, a reverse proxy, phone calls). They are not
described here.

Your time zone is not a key of this file: it is a setting (**Settings → General**). The hub takes it from your browser
when you claim it, and never guesses it from the machine; while none is set, the website shows times in your browser's
zone and the hub uses UTC for quiet hours, the nightly jobs, reminders and the morning brief.

## Secrets and environment

`secrets.env` sits beside the config file (or where `LUADY_SECRETS` points). It holds `SESSION_SECRET` and
`HUB_SOCKET_TOKEN`, which the first start makes and never overwrites, and the keys of the optional modules (see
[Connecting the optional modules](setup-wizard.md#connecting-the-optional-modules)).

The hub also reads these environment variables:

- `LUADY_CONFIG` and `LUADY_SECRETS`: another config file and another secrets file.
- `XDG_CONFIG_HOME` and `XDG_DATA_HOME`: where the config and the data folders go, when they are absolute paths.
- `LOG_LEVEL`: `info` by default; `debug` for more detail.
