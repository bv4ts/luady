#!/usr/bin/env bash
# Daily Luady backup, run as user luady by luady-backup.service. It writes two files to
# $LUADY_HOME/backups and keeps the newest 14 of each:
#   - the SQLite database, through Python's sqlite3 online-backup API (the same API as the sqlite3
#     CLI's .backup; consistent with a live WAL), integrity-checked, then gzipped;
#   - a tarball of the brain directory.
set -euo pipefail
umask 077

LUADY_HOME="${LUADY_HOME:-/home/luady}"
DB="$LUADY_HOME/data/hub.db"
BRAIN="$LUADY_HOME/brain"
OUT="$LUADY_HOME/backups"
KEEP=14
TS="$(date -u +%Y%m%dT%H%M%SZ)"

log() { printf '[backup] %s\n' "$*"; }

backup_db() {
  local partial="$OUT/.luady-$TS.db.partial"
  if [ ! -f "$DB" ]; then log "no database at $DB (skipped)"; return 0; fi
  python3 - "$DB" "$partial" <<'PY'
import sqlite3
import sys

source = sqlite3.connect(sys.argv[1], timeout=30)
target = sqlite3.connect(sys.argv[2])
source.backup(target)
row = target.execute('PRAGMA integrity_check').fetchone()
target.close()
source.close()
if row is None or row[0] != 'ok':
    sys.exit('integrity_check failed: %r' % (row,))
PY
  gzip -9 "$partial"
  mv -f "$partial.gz" "$OUT/luady-$TS.db.gz"
  log "database -> $OUT/luady-$TS.db.gz"
}

backup_brain() {
  local partial="$OUT/.brain-$TS.tgz.partial" rc=0
  if [ ! -d "$BRAIN" ]; then log "no brain directory at $BRAIN (skipped)"; return 0; fi
  # brain/inbox holds files the owner sent on a chat channel (pruned after 14 days); they are not memory.
  tar --warning=no-file-changed --exclude=brain/inbox -C "$LUADY_HOME" -czf "$partial" brain || rc=$?
  # GNU tar exits 1 when a file changed while it was read (Luady may be writing memory); keep that copy.
  [ "$rc" -le 1 ] || { rm -f "$partial"; log "tar failed with exit $rc"; return 1; }
  mv -f "$partial" "$OUT/brain-$TS.tgz"
  log "brain -> $OUT/brain-$TS.tgz"
}

prune() { # <glob>: keep the newest $KEEP files (UTC timestamps sort lexically)
  local name
  while IFS= read -r name; do
    rm -f -- "${OUT:?}/$name"
    log "pruned $name"
  done < <(find "$OUT" -maxdepth 1 -type f -name "$1" -printf '%f\n' | sort -r | tail -n +"$((KEEP + 1))")
}

main() {
  install -d -m 0700 "$OUT"
  find "$OUT" -maxdepth 1 -type f -name '.*.partial*' -delete
  backup_db
  backup_brain
  prune 'luady-*.db.gz'
  prune 'brain-*.tgz'
  log "done"
}

main "$@"
