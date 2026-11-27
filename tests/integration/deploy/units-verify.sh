#!/usr/bin/env bash
# Runs `systemd-analyze verify` on the Luady units in a disposable Ubuntu 24.04 container (run by
# deploy/units.test.ts). Fails on unknown keys, bad calendar specs or a missing ExecStart binary.
set -euo pipefail

main() {
  local units=(luady-hub.service luady-backup.service luady-backup.timer) paths=() out u
  id -u luady >/dev/null 2>&1 || useradd --create-home --shell /bin/bash luady
  install -d -o luady -g luady /home/luady/.local/bin /home/luady/app/current/deploy
  ln -sfn /usr/local/bin/node /home/luady/.local/bin/node
  : > /home/luady/app/current/deploy/backup.sh
  for u in "${units[@]}"; do
    install -m 0644 "/work/deploy/systemd/$u" "/etc/systemd/system/$u"
    paths+=("/etc/systemd/system/$u")
  done
  # The user unit, where a user's systemd loads it from (its %h is that user's home).
  install -d /home/luady/.config/systemd/user /home/luady/luady
  install -m 0644 /work/deploy/systemd/luady.user.service /home/luady/.config/systemd/user/luady.service
  paths+=(/home/luady/.config/systemd/user/luady.service)
  out="$(systemd-analyze verify "${paths[@]}" 2>&1)" || { printf '%s\n' "$out"; exit 1; }
  printf '%s\n' "$out"
  if grep -E 'Unknown (key|section)|Failed to parse|Invalid|is not executable|No such file' <<<"$out"; then
    echo "units-verify: problems found" >&2
    exit 1
  fi
  echo "UNITS VERIFY OK"
}

main "$@"
