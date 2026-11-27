#!/usr/bin/env bash
# Luady release activation. Runs ON THE VPS as root, streamed over ssh by deploy/deploy.sh:
#   ssh … root@203.0.113.10 'bash -s -- activate <UTC ts> /root/luady-deploy/luady-<ts>.tgz' < deploy/remote/activate.sh
#   ssh … root@203.0.113.10 'bash -s -- rollback' < deploy/remote/activate.sh
#   ssh … root@203.0.113.10 'bash -s -- status'   < deploy/remote/activate.sh
# Touches only /home/luady/** and the luady-hub unit. Never prints the hub token.
set -euo pipefail
umask 022

LUADY_HOME=/home/luady
APP="$LUADY_HOME/app"
RELEASES="$APP/releases"
CURRENT="$APP/current"
CONFIG="$LUADY_HOME/.config/luady/config.json"
TOKEN_FILE="$LUADY_HOME/.config/luady/hub-token"
SOCK="$LUADY_HOME/run/hub.sock"
KEEP=5
MIN_FREE_KB=1572864
HEALTH_TRIES="${LUADY_HEALTH_TRIES:-30}"
TS_RE='^[0-9]{8}T[0-9]{6}Z$'
REQUIRED=(package.json package-lock.json RELEASE packages/hub/dist/main.js packages/hub/dist/cli.js
  packages/mcp/dist/main.js packages/web/dist/index.html
  brain/CLAUDE.md server-kit/install.py deploy/backup.sh)

say() { printf '[activate] %s\n' "$*"; }
die() { printf '[activate] ERROR: %s\n' "$*" >&2; exit 1; }

current_release() { if [ -L "$CURRENT" ]; then basename "$(readlink "$CURRENT")"; fi; }

good_releases_desc() {
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | { grep -E "$TS_RE" || true; } | sort -r
}

check_free_space() {
  local free_kb
  free_kb="$(df --output=avail -k "$LUADY_HOME" | tail -n1 | tr -d ' ')"
  [ "$free_kb" -ge "$MIN_FREE_KB" ] || die "only ${free_kb} KB free under $LUADY_HOME (need $MIN_FREE_KB KB); free space first"
}

verify_release() {
  local f
  for f in "${REQUIRED[@]}"; do [ -e "$1/$f" ] || die "release is missing $f"; done
}

install_dependencies() {
  say "npm ci --omit=dev in $1 (as luady)"
  sudo -iu luady bash -c "cd '$1' && npm ci --omit=dev --no-audit --no-fund --loglevel=error"
}

sync_brain() { # copies brain templates; existing memory/** files are never overwritten
  local src="$1" dst="$LUADY_HOME/brain" rel
  install -d -o luady -g luady -m 0750 "$dst"
  while IFS= read -r -d '' rel; do
    install -d -o luady -g luady -m 0750 "$dst/$rel"
  done < <(cd "$src" && find . -mindepth 1 -type d -print0)
  while IFS= read -r -d '' rel; do
    case "$rel" in ./memory/*) if [ -e "$dst/$rel" ]; then continue; fi ;; esac
    install -o luady -g luady -m 0640 "$src/$rel" "$dst/$rel"
  done < <(cd "$src" && find . -type f -print0)
  say "brain templates synced (existing memory/** kept)"
}

switch_to() { # atomic: rename(2) of a fresh symlink over the old one
  ln -sfn "releases/$1" "$APP/current.next"
  chown -h luady:luady "$APP/current.next"
  mv -Tf "$APP/current.next" "$CURRENT"
  say "current -> releases/$1"
}

restart_services() { systemctl restart luady-hub.service; }

health_probe() { # token travels on curl's stdin (-K -), never in argv or output
  local body
  systemctl is-active --quiet luady-hub.service || return 1
  [ -S "$SOCK" ] || return 1
  body="$(printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_FILE")" |
    curl -fsS --max-time 3 -K - --unix-socket "$SOCK" http://localhost/internal/health 2>/dev/null)" || return 1
  [[ "$body" == *'"ok":true'* ]]
}

health_ok() { # healthy twice, 5 s apart, with the same MainPID (catches crash loops)
  local i pid
  for i in $(seq 1 "$HEALTH_TRIES"); do
    if health_probe; then
      pid="$(systemctl show -p MainPID --value luady-hub.service)"
      sleep 5
      if health_probe && [ "$(systemctl show -p MainPID --value luady-hub.service)" = "$pid" ]; then return 0; fi
    fi
    sleep 2
  done
  return 1
}

journal_tail() {
  if command -v journalctl >/dev/null 2>&1; then journalctl -u luady-hub.service -n 60 --no-pager -o cat || true; fi
}

prune() { # keep the newest $KEEP release dirs (by name), plus whatever current points to
  local current name i=0
  current="$(current_release)"
  while IFS= read -r name; do
    i=$((i + 1))
    if [ "$i" -le "$KEEP" ] || [ "$name" = "$current" ]; then continue; fi
    rm -rf -- "${RELEASES:?}/$name"
    say "pruned release $name"
  done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)
}

fail_and_roll_back() { # <failed ts> <previous ts or "">
  say "health check FAILED for $1"
  journal_tail
  if [ -z "$2" ]; then
    systemctl stop luady-hub.service || true
    rm -f "$CURRENT"
    mv -T "$RELEASES/$1" "$RELEASES/$1-failed"
    die "no previous release to roll back to; services stopped and current removed"
  fi
  switch_to "$2"
  restart_services
  mv -T "$RELEASES/$1" "$RELEASES/$1-failed"
  if health_ok; then die "release $1 failed its health check; rolled back to $2 (healthy)"; fi
  die "release $1 failed; rolled back to $2, which is ALSO unhealthy: journalctl -u luady-hub -n 100"
}

activate() { # <ts> <tarball>
  local ts="$1" tarball="$2" dir prev
  [[ "$ts" =~ $TS_RE ]] || die "bad release id: $ts"
  [ -f "$tarball" ] || die "tarball not found: $tarball"
  { id -u luady >/dev/null 2>&1 && [ -d "$RELEASES" ]; } || die "user luady or $RELEASES missing: run deploy/provision.sh first"
  check_free_space
  dir="$RELEASES/$ts"
  [ ! -e "$dir" ] && [ ! -e "$dir-failed" ] || die "release $ts already exists"
  install -d -o luady -g luady -m 0750 "$dir"
  tar -xzf "$tarball" -C "$dir" --no-same-owner --no-same-permissions
  chown -R luady:luady "$dir"
  verify_release "$dir"
  install_dependencies "$dir"
  sync_brain "$dir/brain"
  prev="$(current_release)"
  switch_to "$ts"
  rm -f "$tarball"
  if [ ! -f "$CONFIG" ]; then
    say "config.json missing: release activated, services NOT started (first run: create config.json, then start luady-hub)"
    prune
    return 0
  fi
  restart_services
  if health_ok; then say "healthy: release $ts is live"; prune; return 0; fi
  fail_and_roll_back "$ts" "$prev"
}

rollback() {
  local current target
  current="$(current_release)"
  [ -n "$current" ] || die "no current release"
  target="$(good_releases_desc | awk -v cur="$current" '$0 < cur && !found { print; found = 1 }')"
  [ -n "$target" ] || die "no release older than $current to roll back to"
  switch_to "$target"
  if [ -f "$CONFIG" ]; then
    restart_services
    health_ok || die "rolled back to $target but it is unhealthy: journalctl -u luady-hub -n 100"
  fi
  say "rolled back: $current -> $target"
}

status() {
  say "current: $(current_release)"
  good_releases_desc | sed 's/^/[activate] release /'
  find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -name '*-failed' -printf '[activate] failed %f\n'
  systemctl is-active luady-hub.service || true
}

main() {
  [ "$(id -u)" -eq 0 ] || die "run as root"
  case "${1:-}" in
    activate) [ $# -eq 3 ] || die "usage: activate <UTC ts> <tarball>"; activate "$2" "$3" ;;
    rollback) rollback ;;
    status) status ;;
    *) die "usage: activate <UTC ts> <tarball> | rollback | status" ;;
  esac
}

main "$@" </dev/null
