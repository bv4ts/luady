#!/usr/bin/env bash
# Runs deploy/provision.sh twice as root in a disposable Ubuntu 24.04 container (no systemd), then once
# more without a system Node. It checks that:
#   - the second run is a no-op that prints no secret;
#   - the layout and modes are right;
#   - the private-Node fallback works.
# Needs network: Claude Code installer, pkg.cloudflare.com, nodejs.org.
set -euo pipefail
PROVISION=/work/deploy/provision.sh

fail() { echo "PROVISION TEST FAIL: $*" >&2; exit 1; }

snapshot() {
  local f
  for f in /home/luady/.config/luady/secrets.env /home/luady/.config/luady/hub-token /home/luady/.ssh/id_ed25519_fleet \
           /home/luady/.ssh/id_ed25519_fleet.pub /home/luady/.profile /etc/systemd/system/luady-hub.service \
           /etc/systemd/system/luady-backup.service /etc/systemd/system/luady-backup.timer; do
    printf '%s %s %s\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$(stat -c '%a %U:%G' "$f")" "$f"
  done
}

expect_mode() { # <path> <mode> <owner>
  [ "$(stat -c '%a %U' "$1")" = "$2 $3" ] || fail "$1 is $(stat -c '%a %U' "$1"), expected $2 $3"
}

check_layout() {
  local d
  [ "$(getent passwd luady | cut -d: -f7)" = /bin/bash ] || fail "luady shell is not /bin/bash"
  if id -nG luady | tr ' ' '\n' | grep -qx sudo; then fail "luady is in the sudo group"; fi
  for d in data run run/tmp backups .config .config/luady .ssh; do expect_mode "/home/luady/$d" 700 luady; done
  for d in . app app/releases brain; do expect_mode "/home/luady/$d" 750 luady; done
  expect_mode /home/luady/.config/luady/secrets.env 600 luady
  expect_mode /home/luady/.config/luady/hub-token 600 luady
  expect_mode /home/luady/.ssh/id_ed25519_fleet 600 luady
  [ "$(grep -c '>>> luady env' /home/luady/.profile)" = 1 ] || fail "profile env block missing or duplicated"
  for d in luady-hub.service luady-backup.service luady-backup.timer; do
    cmp -s "/etc/systemd/system/$d" "/work/deploy/systemd/$d" || fail "$d differs from deploy/systemd/$d"
  done
}

check_secrets() { # <provision outputs...>
  local secrets=/home/luady/.config/luady/secrets.env session token
  session="$(sed -n 's/^SESSION_SECRET=//p' "$secrets")"
  token="$(sed -n 's/^HUB_SOCKET_TOKEN=//p' "$secrets")"
  [[ "$session" =~ ^[0-9a-f]{64}$ ]] || fail "SESSION_SECRET is not 64 hex"
  [[ "$token" =~ ^[0-9a-f]{64}$ ]] || fail "HUB_SOCKET_TOKEN is not 64 hex"
  grep -qx 'CF_ACCESS_AUD=' "$secrets" || fail "CF_ACCESS_AUD is not present and empty"
  [ "$(cat /home/luady/.config/luady/hub-token)" = "$token" ] || fail "hub-token differs from HUB_SOCKET_TOKEN"
  if grep -qF -e "$session" -e "$token" <<<"$*"; then fail "a secret value appeared in provision output"; fi
}

check_tools() {
  sudo -iu luady /home/luady/.local/bin/claude --version | grep -q 'Claude Code' || fail "claude --version failed for luady"
  cloudflared --version | grep -qi cloudflared || fail "cloudflared is not installed"
  sudo -iu luady node -v | grep -q '^v22\.' || fail "node for luady is not v22"
  sudo -iu luady bash -c 'echo "$TMUX_TMPDIR $LUADY_CONFIG"' | grep -qx '/home/luady/run /home/luady/.config/luady/config.json' \
    || fail "luady login shells lack TMUX_TMPDIR / LUADY_CONFIG"
}

main() {
  local out1 out2 out3 before after
  out1="$(bash "$PROVISION" 2>&1)" || { printf '%s\n' "$out1"; fail "first run failed"; }
  printf '%s\n' "$out1"
  grep -q 'luady-hub NOT started' <<<"$out1" || fail "first run did not report that luady-hub stays stopped"
  grep -q '^ssh-ed25519 ' <<<"$out1" || fail "fleet public key not printed"
  before="$(snapshot)"
  out2="$(bash "$PROVISION" 2>&1)" || { printf '%s\n' "$out2"; fail "second run failed"; }
  printf '%s\n' "$out2"
  after="$(snapshot)"
  [ "$before" = "$after" ] || { diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") || true; fail "second run changed files"; }
  if grep -E ': (created|generated|installed|added|updated)' <<<"$out2"; then fail "second run reported a change"; fi
  check_layout
  check_secrets "$out1" "$out2"
  check_tools
  mv /usr/local/bin/node /usr/local/bin/node.off
  out3="$(bash "$PROVISION" 2>&1)" || { printf '%s\n' "$out3"; mv /usr/local/bin/node.off /usr/local/bin/node; fail "run without a system node failed"; }
  mv /usr/local/bin/node.off /usr/local/bin/node
  [ "$(readlink -f /home/luady/.local/bin/node)" = /home/luady/.local/lib/node-v22.22.0-linux-x64/bin/node ] || fail "private node not linked"
  [ "$(sudo -iu luady node -v)" = v22.22.0 ] || fail "private node is not v22.22.0"
  echo "PROVISION TEST OK"
}

main "$@"
