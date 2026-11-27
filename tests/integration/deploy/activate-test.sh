#!/usr/bin/env bash
# Exercises deploy/remote/activate.sh in a disposable Ubuntu 24.04 container (root, no systemd). It covers:
#   1. first activation without config.json;
#   2. a healthy deploy;
#   3. a broken release with automatic rollback;
#   4. manual rollback;
#   5. keep-5 pruning;
#   6. argument validation.
# Brain memory must survive every deploy.
set -euo pipefail
ACT=/work/deploy/remote/activate.sh
HERE=/work/tests/integration/deploy

fail() { echo "ACTIVATE TEST FAIL: $*" >&2; exit 1; }
current() { basename "$(readlink /home/luady/app/current)"; }

setup_vps() {
  local d
  useradd --create-home --shell /bin/bash luady
  for d in app app/releases data brain run run/tmp backups .config .config/luady .ssh .local .local/bin; do
    install -d -o luady -g luady -m 0750 "/home/luady/$d"
  done
  ln -s /usr/local/bin/node /home/luady/.local/bin/node
  ln -s /usr/local/bin/npm /home/luady/.local/bin/npm
  openssl rand -hex 32 | tr -d '\n' > /home/luady/.config/luady/hub-token
  chown luady:luady /home/luady/.config/luady/hub-token
  chmod 0600 /home/luady/.config/luady/hub-token
  install -m 0755 "$HERE/fake-systemctl.sh" /usr/local/bin/systemctl
}

make_release() { # <ts> <OK|BROKEN> [extra memory template]
  local ts="$1" marker="$2" extra="${3:-}" stage p
  stage="$(mktemp -d)"
  mkdir -p "$stage/brain/memory/journal" "$stage/brain/.manager" "$stage/server-kit" "$stage/deploy"
  printf '{ "name": "luady", "version": "0.0.0", "private": true }\n' > "$stage/package.json"
  printf '{ "name": "luady", "version": "0.0.0", "lockfileVersion": 3, "requires": true, "packages": { "": { "name": "luady", "version": "0.0.0" } } }\n' > "$stage/package-lock.json"
  for p in shared hub mcp web; do
    mkdir -p "$stage/packages/$p/dist"
    printf '{ "name": "@luady/%s", "version": "0.0.0", "private": true }\n' "$p" > "$stage/packages/$p/package.json"
  done
  printf '// %s %s\n' "$marker" "$ts" > "$stage/packages/hub/dist/main.js"
  printf '// cli %s\n' "$ts" > "$stage/packages/hub/dist/cli.js"
  printf '// mcp %s\n' "$ts" > "$stage/packages/mcp/dist/main.js"
  printf '<!doctype html><title>%s</title>\n' "$ts" > "$stage/packages/web/dist/index.html"
  printf '# Luady brain %s\n' "$ts" > "$stage/brain/CLAUDE.md"
  printf '{}\n' > "$stage/brain/.manager/settings.json"
  printf '# USER template %s\n' "$ts" > "$stage/brain/memory/USER.md"
  : > "$stage/brain/memory/journal/.gitkeep"
  if [ -n "$extra" ]; then printf '# %s template\n' "$extra" > "$stage/brain/memory/$extra"; fi
  printf 'print("kit")\n' > "$stage/server-kit/install.py"
  printf '#!/usr/bin/env bash\n' > "$stage/deploy/backup.sh"
  printf 'release=%s\n' "$ts" > "$stage/RELEASE"
  tar -czf "/tmp/luady-$ts.tgz" -C "$stage" .
  rm -rf "$stage"
}

deploy() { make_release "$1" "$2" "${3:-}"; bash "$ACT" activate "$1" "/tmp/luady-$1.tgz"; }

main() {
  local n left
  setup_vps

  deploy 20260101T000001Z OK                                   # 1. no config.json yet
  [ "$(current)" = 20260101T000001Z ] || fail "1: current is $(current)"
  if grep -q restart /tmp/systemctl.log 2>/dev/null; then fail "1: services restarted without config.json"; fi
  [ ! -e /tmp/luady-20260101T000001Z.tgz ] || fail "1: uploaded tarball not removed"
  [ "$(stat -c %U /home/luady/app/releases/20260101T000001Z/packages/hub/dist/main.js)" = luady ] || fail "1: release not owned by luady"

  printf '# edited by Luady\n' > /home/luady/brain/memory/USER.md   # 2. healthy deploy keeps memory
  printf '{}\n' > /home/luady/.config/luady/config.json
  deploy 20260101T000002Z OK DECISIONS.md
  [ "$(current)" = 20260101T000002Z ] || fail "2: current is $(current)"
  grep -q 'restart luady-hub' /tmp/systemctl.log || fail "2: luady-hub not restarted"
  [ "$(cat /home/luady/brain/memory/USER.md)" = '# edited by Luady' ] || fail "2: memory/USER.md was overwritten"
  grep -q 20260101T000002Z /home/luady/brain/CLAUDE.md || fail "2: CLAUDE.md template not updated"
  [ -f /home/luady/brain/memory/DECISIONS.md ] || fail "2: new memory template not added"

  if deploy 20260101T000003Z BROKEN; then fail "3: broken release reported success"; fi   # 3. automatic rollback
  [ "$(current)" = 20260101T000002Z ] || fail "3: not rolled back (current=$(current))"
  [ -d /home/luady/app/releases/20260101T000003Z-failed ] || fail "3: failed release not marked"
  pgrep -f fake_hub.py >/dev/null || fail "3: hub not running after the rollback"

  bash "$ACT" rollback                                          # 4. manual rollback skips -failed
  [ "$(current)" = 20260101T000001Z ] || fail "4: rollback went to $(current)"

  for n in 4 5 6 7 8 9; do deploy "20260101T00000${n}Z" OK; done   # 5. keep the newest 5
  left="$(find /home/luady/app/releases -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | tr '\n' ' ')"
  [ "$left" = '20260101T000005Z 20260101T000006Z 20260101T000007Z 20260101T000008Z 20260101T000009Z ' ] || fail "5: kept $left"
  [ "$(current)" = 20260101T000009Z ] || fail "5: current is $(current)"

  if bash "$ACT" activate 'bad;id' /tmp/x.tgz 2>/dev/null; then fail "6: bad release id accepted"; fi   # 6. validation
  if sudo -u luady bash "$ACT" status 2>/dev/null; then fail "6: non-root run accepted"; fi
  echo "ACTIVATE TEST OK"
}

main "$@"
