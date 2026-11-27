#!/usr/bin/env bash
# Build, pack, upload and activate a Luady release on the VPS (key auth only), or roll back.
#   bash deploy/deploy.sh                 npm ci + build + pack + upload + activate (asks first)
#   bash deploy/deploy.sh --pack-only     build + pack locally, print the tarball path (no network)
#   bash deploy/deploy.sh --skip-build    reuse the current dist/ folders
#   bash deploy/deploy.sh --rollback      switch the VPS back to the previous good release
#   bash deploy/deploy.sh --status        show current and kept releases and unit states
# --yes skips the confirmation (use it only after you have read what it will do). `npm run deploy -- <flags>` works too.
# shellcheck source-path=SCRIPTDIR
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=lib/common.sh
. deploy/lib/common.sh

PACKAGES=(shared office hub mcp web)
ACTIVATE=deploy/remote/activate.sh
SKIP_BUILD=0
PACK_ONLY=0

build() {
  log "npm ci && npm run build"
  npm ci --no-audit --no-fund
  npm run build
}

stage_release() { # <ts> <stage dir>
  local p commit
  cp package.json package-lock.json "$2/"
  for p in "${PACKAGES[@]}"; do
    [ -d "packages/$p/dist" ] || die "packages/$p/dist is missing (did the build run?)"
    mkdir -p "$2/packages/$p"
    cp "packages/$p/package.json" "$2/packages/$p/package.json"
    cp -R "packages/$p/dist" "$2/packages/$p/dist"
  done
  cp -R brain "$2/brain"
  cp -R server-kit "$2/server-kit"
  find "$2/server-kit" -type d -name '__pycache__' -prune -exec rm -rf {} +
  mkdir -p "$2/deploy"
  cp deploy/backup.sh "$2/deploy/backup.sh"
  commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  printf 'release=%s\ncommit=%s\nbuilt_at=%s\n' "$1" "$commit" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$2/RELEASE"
}

pack() { # <ts> -> tarball path on stdout
  local stage out
  assert_lf_tree brain server-kit deploy/backup.sh "$ACTIVATE"
  stage="$(mktemp -d)"
  out="$(mktemp -d)/luady-$1.tgz"
  stage_release "$1" "$stage"
  tar -czf "$out" -C "$stage" .
  rm -rf "$stage"
  printf '%s\n' "$out"
}

deploy_release() {
  local ts tarball
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  if [ "$SKIP_BUILD" = 0 ]; then build; fi
  tarball="$(pack "$ts")"
  log "packed $tarball ($(du -h "$tarball" | cut -f1))"
  if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then log "warning: the working tree has uncommitted changes"; fi
  if [ "$PACK_ONLY" = 1 ]; then tar -tzf "$tarball" | sed -n '1,40p' >&2; printf '%s\n' "$tarball"; return 0; fi
  confirm "Deploy release $ts to $LUADY_VPS (restarts luady-hub; automatic rollback if unhealthy)?"
  vps_ssh 'install -d -m 0700 /root/luady-deploy' </dev/null
  vps_scp -q "$tarball" "$LUADY_VPS:/root/luady-deploy/luady-$ts.tgz"
  vps_ssh "bash -s -- activate $ts /root/luady-deploy/luady-$ts.tgz" < "$ACTIVATE"
  rm -f "$tarball"
  log "deployed release $ts"
}

main() {
  local mode=deploy
  while [ $# -gt 0 ]; do
    case "$1" in
      --skip-build) SKIP_BUILD=1 ;;
      --pack-only) PACK_ONLY=1 ;;
      --rollback) mode=rollback ;;
      --status) mode=status ;;
      --yes) ASSUME_YES=1 ;;
      *) die "usage: deploy/deploy.sh [--skip-build] [--pack-only] [--yes] | --rollback [--yes] | --status" ;;
    esac
    shift
  done
  require_cmds npm node tar ssh scp
  case "$mode" in
    deploy) deploy_release ;;
    rollback)
      confirm "Roll back luady on $LUADY_VPS to the previous good release (restarts luady-hub)?"
      vps_ssh 'bash -s -- rollback' < "$ACTIVATE" ;;
    status) vps_ssh 'bash -s -- status' < "$ACTIVATE" ;;
  esac
}

main "$@"
