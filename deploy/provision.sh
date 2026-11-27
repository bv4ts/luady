#!/usr/bin/env bash
# Luady VPS provisioning (idempotent). Run as root from your local computer, key auth only:
#   ssh -i ~/.ssh/luady_vps_deploy root@203.0.113.10 'bash -s' < deploy/provision.sh
# Creates the unprivileged user luady and its directories, then installs:
#   - Claude Code for luady (official native installer);
#   - cloudflared (Cloudflare apt repo);
#   - the fleet SSH key, secrets.env and hub-token;
#   - the systemd units.
# Never touches the SSH daemon, the firewall, nginx, docker, pm2, other users or the root password;
# never starts luady-hub; never prints a secret value.
set -euo pipefail
umask 022

LUADY_USER=luady
LUADY_HOME=/home/luady
NODE_PIN_VERSION=v22.22.0
NODE_PIN_SHA256=9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37
UNITS_CHANGED=0
NODE_BIN=""
CLEANUP=()

say() { printf '[provision] %s\n' "$*"; }
die() { printf '[provision] ERROR: %s\n' "$*" >&2; exit 1; }
cleanup() { if [ "${#CLEANUP[@]}" -gt 0 ]; then rm -rf -- "${CLEANUP[@]}"; fi; }
trap cleanup EXIT

apt_quiet() { # needrestart suspended: installing a package must never restart client services
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 NEEDRESTART_MODE=l \
    apt-get -o DPkg::Lock::Timeout=300 -y -q "$@"
}

preflight() {
  local tool
  [ "$(id -u)" -eq 0 ] || die "run as root"
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || die "expected Ubuntu 24.04, found ${PRETTY_NAME:-unknown}"
  for tool in curl openssl sudo python3 ssh-keygen tar xz sha256sum useradd getent install cmp; do
    command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
  done
  say "preflight: ok ($PRETTY_NAME)"
}

ensure_user() {
  if id -u "$LUADY_USER" >/dev/null 2>&1; then
    say "user $LUADY_USER: present (unchanged)"
  else
    useradd --create-home --home-dir "$LUADY_HOME" --shell /bin/bash --user-group "$LUADY_USER"
    say "user $LUADY_USER: created"
  fi
  if id -nG "$LUADY_USER" | tr ' ' '\n' | grep -qx sudo; then
    die "$LUADY_USER is in the sudo group; remove it (gpasswd -d $LUADY_USER sudo) and re-run"
  fi
  if [ "$(getent passwd "$LUADY_USER" | cut -d: -f7)" != /bin/bash ]; then
    usermod --shell /bin/bash "$LUADY_USER"
    say "user $LUADY_USER: shell updated to /bin/bash"
  fi
}

ensure_dirs() {
  local entry
  for entry in .:0750 app:0750 app/releases:0750 data:0700 brain:0750 run:0700 run/tmp:0700 \
               backups:0700 .config:0700 .config/luady:0700 .ssh:0700 .local:0755 .local/bin:0755; do
    install -d -o "$LUADY_USER" -g "$LUADY_USER" -m "${entry##*:}" "$LUADY_HOME/${entry%%:*}"
  done
  say "directories: ok (data, run, backups, .config/luady and .ssh are 0700)"
}

ensure_profile_env() {
  local profile="$LUADY_HOME/.profile" marker='# >>> luady env (managed by deploy/provision.sh) >>>'
  [ -f "$profile" ] || install -o "$LUADY_USER" -g "$LUADY_USER" -m 0644 /dev/null "$profile"
  if grep -qF "$marker" "$profile"; then say "profile env: present (unchanged)"; return; fi
  cat >>"$profile" <<'EOF'

# >>> luady env (managed by deploy/provision.sh) >>>
export TMUX_TMPDIR="$HOME/run"
export LUADY_CONFIG="$HOME/.config/luady/config.json"
export LUADY_SECRETS="$HOME/.config/luady/secrets.env"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$HOME/.local/bin:$PATH" ;; esac
# <<< luady env <<<
EOF
  say "profile env: added (TMUX_TMPDIR, LUADY_CONFIG, LUADY_SECRETS, PATH)"
}

ensure_tmux() {
  if command -v tmux >/dev/null 2>&1; then say "tmux: present ($(tmux -V))"; return; fi
  say "tmux: missing, installing with apt (needrestart suspended)"
  apt_quiet update
  apt_quiet install --no-install-recommends tmux
  say "tmux: installed ($(tmux -V))"
}

resolve_system_node() {
  local candidate
  for candidate in /usr/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ] && sudo -u "$LUADY_USER" "$candidate" -v 2>/dev/null | grep -q '^v22\.'; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

install_private_node() { # sets NODE_BIN; used only when no system Node 22 is usable by luady
  local dir="$LUADY_HOME/.local/lib/node-$NODE_PIN_VERSION-linux-x64" tmp
  NODE_BIN="$dir/bin/node"
  if [ -x "$NODE_BIN" ]; then return 0; fi
  tmp="$(mktemp -d)"
  CLEANUP+=("$tmp")
  curl -fsSL -o "$tmp/node.tar.xz" "https://nodejs.org/dist/$NODE_PIN_VERSION/node-$NODE_PIN_VERSION-linux-x64.tar.xz"
  printf '%s  %s\n' "$NODE_PIN_SHA256" "$tmp/node.tar.xz" | sha256sum -c --quiet - || die "Node tarball checksum mismatch"
  install -d -o "$LUADY_USER" -g "$LUADY_USER" -m 0755 "$LUADY_HOME/.local/lib"
  tar -xJf "$tmp/node.tar.xz" -C "$LUADY_HOME/.local/lib"
  chown -R "$LUADY_USER:$LUADY_USER" "$dir"
}

ensure_node() {
  if NODE_BIN="$(resolve_system_node)"; then
    say "node: system $NODE_BIN ($(sudo -u "$LUADY_USER" "$NODE_BIN" -v))"
  else
    say "node: no system Node 22 usable by $LUADY_USER; using the private sha256-pinned $NODE_PIN_VERSION"
    install_private_node
  fi
  [ -x "$(dirname "$NODE_BIN")/npm" ] || die "npm not found next to $NODE_BIN"
  ln -sfn "$NODE_BIN" "$LUADY_HOME/.local/bin/node"
  ln -sfn "$(dirname "$NODE_BIN")/npm" "$LUADY_HOME/.local/bin/npm"
  chown -h "$LUADY_USER:$LUADY_USER" "$LUADY_HOME/.local/bin/node" "$LUADY_HOME/.local/bin/npm"
}

ensure_claude() {
  local claude="$LUADY_HOME/.local/bin/claude"
  if [ -x "$claude" ]; then
    say "claude: present ($(sudo -iu "$LUADY_USER" "$claude" --version 2>/dev/null || echo 'version unknown'))"
    return
  fi
  say "claude: running the official native installer for $LUADY_USER"
  sudo -iu "$LUADY_USER" bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
  [ -x "$claude" ] || die "claude is not at $claude after the installer ran"
  say "claude: installed ($(sudo -iu "$LUADY_USER" "$claude" --version))"
}

ensure_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then say "cloudflared: present ($(cloudflared --version 2>&1 | head -n1))"; return; fi
  say "cloudflared: adding Cloudflare's apt repository (pkg.cloudflare.com, suite 'any')"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  printf '%s\n' 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
    > /etc/apt/sources.list.d/cloudflared.list
  apt_quiet update
  apt_quiet install --no-install-recommends cloudflared
  say "cloudflared: installed ($(cloudflared --version 2>&1 | head -n1))"
}

ensure_fleet_key() {
  local key="$LUADY_HOME/.ssh/id_ed25519_fleet"
  if [ -f "$key" ]; then
    say "fleet key: present (unchanged)"
  else
    sudo -u "$LUADY_USER" -H ssh-keygen -q -t ed25519 -N '' -C "luady-fleet@$(hostname -s)" -f "$key"
    say "fleet key: generated"
  fi
  [ -f "$key.pub" ] || die "$key exists but $key.pub is missing; restore it or move the key away and re-run"
  chmod 0600 "$key"
  chmod 0644 "$key.pub"
  chown "$LUADY_USER:$LUADY_USER" "$key" "$key.pub"
}

add_secret_if_missing() { # <file> <key> <hex|empty>; values are generated in-process and never printed
  if grep -q "^$2=" "$1"; then say "secret $2: present (unchanged)"; return; fi
  if [ "$3" = hex ]; then
    printf '%s=%s\n' "$2" "$(openssl rand -hex 32)" >> "$1"
    say "secret $2: generated"
  else
    printf '%s=\n' "$2" >> "$1"
    say "secret $2: added (empty: put the Cloudflare Access application's AUD tag here)"
  fi
}

ensure_secrets() {
  local secrets="$LUADY_HOME/.config/luady/secrets.env" token_file="$LUADY_HOME/.config/luady/hub-token" token
  if [ ! -f "$secrets" ]; then install -o "$LUADY_USER" -g "$LUADY_USER" -m 0600 /dev/null "$secrets"; say "secrets.env: created"; fi
  add_secret_if_missing "$secrets" SESSION_SECRET hex
  add_secret_if_missing "$secrets" HUB_SOCKET_TOKEN hex
  add_secret_if_missing "$secrets" CF_ACCESS_AUD empty
  chown "$LUADY_USER:$LUADY_USER" "$secrets"
  chmod 0600 "$secrets"
  token="$(sed -n 's/^HUB_SOCKET_TOKEN=//p' "$secrets")"
  [[ "$token" =~ ^[0-9a-f]{64}$ ]] || die "HUB_SOCKET_TOKEN in $secrets is not exactly one 64-hex value"
  if [ ! -f "$token_file" ]; then
    install -o "$LUADY_USER" -g "$LUADY_USER" -m 0600 /dev/null "$token_file"
    printf '%s' "$token" > "$token_file"
    say "hub-token: created"
  elif [ "$(cat "$token_file")" != "$token" ]; then
    die "$token_file differs from HUB_SOCKET_TOKEN in secrets.env; reconcile by hand (provision never overwrites secrets)"
  else
    say "hub-token: present (unchanged)"
  fi
  chown "$LUADY_USER:$LUADY_USER" "$token_file"
  chmod 0600 "$token_file"
}

write_unit() { # <name>; unit text on stdin
  local name="$1" dest="/etc/systemd/system/$1" tmp
  tmp="$(mktemp)"
  CLEANUP+=("$tmp")
  cat >"$tmp"
  if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then
    say "unit $name: present (unchanged)"
  else
    install -o root -g root -m 0644 "$tmp" "$dest"
    UNITS_CHANGED=1
    say "unit $name: installed"
  fi
}

unit_luady_hub() {
  write_unit luady-hub.service <<'UNIT'
# Luady hub: fleet, routing, web/API on 127.0.0.1:7410, internal API on /home/luady/run/hub.sock, brain supervisor.
# Installed by deploy/provision.sh, which embeds a byte-identical copy (tests enforce it).
[Unit]
Description=Luady hub (fleet, router, web, internal API, brain supervisor)
After=network-online.target
Wants=network-online.target
ConditionPathExists=/home/luady/.config/luady/config.json
ConditionPathExists=/home/luady/app/current/packages/hub/dist/main.js
StartLimitIntervalSec=600
StartLimitBurst=20

[Service]
Type=simple
User=luady
Group=luady
WorkingDirectory=/home/luady/app/current
Environment=NODE_ENV=production
Environment=LUADY_CONFIG=/home/luady/.config/luady/config.json
Environment=LUADY_SECRETS=/home/luady/.config/luady/secrets.env
Environment=TMUX_TMPDIR=/home/luady/run
Environment=TMPDIR=/home/luady/run/tmp
Environment=PATH=/home/luady/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin
ExecStart=/home/luady/.local/bin/node packages/hub/dist/main.js
Restart=always
RestartSec=5
# Restarts stop only the node process. The brain's tmux server (socket under TMUX_TMPDIR, outside
# PrivateTmp) keeps running, and the next hub process re-adopts it.
KillMode=process
TimeoutStopSec=20
MemoryMax=2G
CPUQuota=200%
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=/home/luady
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
}

unit_luady_backup_service() {
  write_unit luady-backup.service <<'UNIT'
# Daily Luady backup (SQLite online backup + brain tarball, keep 14). Triggered by luady-backup.timer.
# Installed by deploy/provision.sh, which embeds a byte-identical copy (tests enforce it).
[Unit]
Description=Luady daily backup (database + brain, keep 14)
ConditionPathExists=/home/luady/app/current/deploy/backup.sh

[Service]
Type=oneshot
User=luady
Group=luady
Environment=LUADY_HOME=/home/luady
ExecStart=/bin/bash /home/luady/app/current/deploy/backup.sh
Nice=10
IOSchedulingClass=idle
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=full
ReadWritePaths=/home/luady
UMask=0077
UNIT
}

unit_luady_backup_timer() {
  write_unit luady-backup.timer <<'UNIT'
# Runs luady-backup.service daily at 04:30 in the server's own local time.
# Installed by deploy/provision.sh, which embeds a byte-identical copy (tests enforce it).
[Unit]
Description=Daily Luady backup at 04:30 local time

[Timer]
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=600
Persistent=true

[Install]
WantedBy=timers.target
UNIT
}

activate_units() {
  if [ ! -d /run/systemd/system ]; then
    say "systemd: not running here (container?); skipped daemon-reload and enable"
    return
  fi
  if [ "$UNITS_CHANGED" -eq 1 ]; then systemctl daemon-reload; say "systemd: daemon-reload done"; fi
  systemctl enable luady-hub.service >/dev/null 2>&1
  systemctl enable --now luady-backup.timer >/dev/null 2>&1
  say "systemd: luady-hub enabled for boot (skipped until config.json exists); luady-backup.timer active"
  if [ "$UNITS_CHANGED" -eq 1 ] && systemctl is-active --quiet luady-hub.service; then
    say "unit files changed while luady-hub runs: apply with 'systemctl restart luady-hub' when a restart is safe"
  fi
}

report() {
  say "fleet public key (the website's Add a server shows the line to paste on each server):"
  cat "$LUADY_HOME/.ssh/id_ed25519_fleet.pub"
  if [ -f "$LUADY_HOME/.config/luady/config.json" ]; then
    say "config.json exists; this script never starts or restarts luady-hub (deploy.sh starts it, or you do)"
  else
    say "luady-hub NOT started: config.json is missing (create it, then start luady-hub)"
  fi
  say "done"
}

main() {
  preflight
  ensure_user
  ensure_dirs
  ensure_profile_env
  ensure_tmux
  ensure_node
  ensure_claude
  ensure_cloudflared
  ensure_fleet_key
  ensure_secrets
  unit_luady_hub
  unit_luady_backup_service
  unit_luady_backup_timer
  activate_units
  report
}

main "$@" </dev/null
