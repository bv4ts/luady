#!/usr/bin/env bash
# Container entrypoint. It installs the per-run keys mounted at /run/luady-keys (CR stripped, strict
# modes), then starts sshd in the background. Tests can then kill and restart sshd without
# stopping the container; compose runs tini as PID 1 via `init: true`.
set -euo pipefail
KEYS=/run/luady-keys

put() { # <src> <dest> <mode> [owner]
  tr -d '\r' <"$1" >"$2"
  chmod "$3" "$2"
  if [ -n "${4:-}" ]; then chown "$4" "$2"; fi
}

main() {
  local f
  for f in ssh_host_ed25519_key ssh_host_ed25519_key.pub client_ed25519.pub; do
    [ -s "$KEYS/$f" ] || { echo "entrypoint: missing $KEYS/$f" >&2; exit 1; }
  done
  put "$KEYS/ssh_host_ed25519_key" /etc/ssh/ssh_host_ed25519_key 0600
  put "$KEYS/ssh_host_ed25519_key.pub" /etc/ssh/ssh_host_ed25519_key.pub 0644
  install -d -o dev -g dev -m 0700 /home/dev/.ssh
  put "$KEYS/client_ed25519.pub" /home/dev/.ssh/authorized_keys 0600 dev:dev
  mkdir -p /run/sshd
  /usr/sbin/sshd -t
  /usr/sbin/sshd
  exec sleep infinity
}

main "$@"
