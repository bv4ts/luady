#!/usr/bin/env bash
# Test double for systemctl in the deploy test container. "luady-hub" is fake_hub.py serving
# /internal/health on /home/luady/run/hub.sock; it refuses to start when the current release is BROKEN.
set -u
echo "systemctl $*" >> /tmp/systemctl.log

hub_pid() { pgrep -f fake_hub.py | head -n1; }

start_hub() {
  pkill -f fake_hub.py 2>/dev/null || true
  rm -f /home/luady/run/hub.sock
  # shellcheck disable=SC2024  # the log is intentionally written by the invoking root shell
  sudo -u luady nohup python3 /work/tests/integration/deploy/fake_hub.py >>/tmp/fake_hub.log 2>&1 &
  sleep 0.3
}

main() {
  local cmd="${1:-}" unit
  [ $# -gt 0 ] && shift
  case "$cmd" in
    restart|start)
      for unit in "$@"; do case "$unit" in luady-hub|luady-hub.service) start_hub ;; esac; done ;;
    stop)
      for unit in "$@"; do case "$unit" in luady-hub|luady-hub.service) pkill -f fake_hub.py 2>/dev/null || true ;; esac; done ;;
    is-active)
      [ "${1:-}" = --quiet ] && shift
      case "${1:-}" in luady-hub|luady-hub.service) [ -n "$(hub_pid)" ] ;; *) return 0 ;; esac ;;
    show)
      local pid
      pid="$(hub_pid)"
      echo "${pid:-0}" ;;
    *) return 0 ;;
  esac
}

main "$@"
