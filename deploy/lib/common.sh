#!/usr/bin/env bash
# Shared helpers for the deploy script that runs on your local computer (Git Bash on Windows, or any bash >= 4). Source it; do not
# execute it. SSH is key-only (BatchMode, publickey). Servers are added and removed from the website (the hub
# keeps their key line and kit); these helpers only reach the VPS. Optional overrides:
#   LUADY_VPS         VPS login (default root@203.0.113.10)
#   LUADY_VPS_KEY     VPS identity file (default ~/.ssh/luady_vps_deploy)
# shellcheck disable=SC2034  # these variables are read by the scripts that source this file

LUADY_VPS="${LUADY_VPS:-root@203.0.113.10}"
LUADY_VPS_KEY="${LUADY_VPS_KEY:-$HOME/.ssh/luady_vps_deploy}"
ASSUME_YES="${ASSUME_YES:-0}"
SSH_OPTS=(-o BatchMode=yes -o PreferredAuthentications=publickey -o ConnectTimeout=15)

log() { printf '[luady] %s\n' "$*" >&2; }
die() { printf '[luady] ERROR: %s\n' "$*" >&2; exit 1; }

require_cmds() {
  local cmd
  for cmd in "$@"; do command -v "$cmd" >/dev/null 2>&1 || die "missing command: $cmd"; done
}

confirm() { # <question>; --yes (ASSUME_YES=1) skips the prompt (use it only after you have read what will change)
  local answer
  if [ "$ASSUME_YES" = 1 ]; then return 0; fi
  [ -t 0 ] || die "refusing to change state without a terminal; re-run with --yes after you have read what will change"
  read -r -p "[luady] $1 [y/N] " answer
  case "$answer" in y|Y) return 0 ;; *) die "cancelled" ;; esac
}

vps_ssh() { ssh "${SSH_OPTS[@]}" -o IdentitiesOnly=yes -i "$LUADY_VPS_KEY" "$LUADY_VPS" "$@"; }
vps_scp() { scp "${SSH_OPTS[@]}" -o IdentitiesOnly=yes -i "$LUADY_VPS_KEY" "$@"; }

assert_lf_tree() { # <paths...>: files shipped to Linux must not contain CR
  local hits
  hits="$(grep -rlI -e "$(printf '\r')" -- "$@" 2>/dev/null || true)"
  [ -z "$hits" ] || die "CRLF line endings (convert to LF first): $hits"
}
