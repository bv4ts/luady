#!/usr/bin/env bash
# Verifies deploy/backup.sh in a disposable Ubuntu 24.04 container (run by deploy/backup.test.ts).
# It checks that:
#   - a live WAL database is captured completely;
#   - the brain is archived;
#   - old backups are pruned to 14 and stale partials are removed;
#   - every file is private.
set -euo pipefail
export LUADY_HOME=/tmp/luady-home
WRITER=""

fail() { echo "BACKUP TEST FAIL: $*" >&2; exit 1; }

seed() {
  local i
  rm -rf "$LUADY_HOME"
  mkdir -p "$LUADY_HOME/data" "$LUADY_HOME/brain/memory/journal" "$LUADY_HOME/backups"
  printf '# user\n' > "$LUADY_HOME/brain/memory/USER.md"
  for i in $(seq -w 1 15); do
    : > "$LUADY_HOME/backups/luady-202601${i}T000000Z.db.gz"
    : > "$LUADY_HOME/backups/brain-202601${i}T000000Z.tgz"
  done
  : > "$LUADY_HOME/backups/.luady-20260101T000000Z.db.partial"
}

hold_wal_writer() { # keeps 500 committed but uncheckpointed rows in the WAL while the backup runs
  local i
  python3 - "$LUADY_HOME/data/hub.db" <<'PY' &
import sqlite3, sys, time
db = sqlite3.connect(sys.argv[1])
db.execute('PRAGMA journal_mode=WAL')
db.execute('PRAGMA wal_autocheckpoint=0')
db.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
db.executemany('INSERT INTO t (v) VALUES (?)', [('row %d' % i,) for i in range(500)])
db.commit()
open('/tmp/writer-ready', 'w').close()
time.sleep(30)
PY
  WRITER=$!
  for i in $(seq 1 50); do [ -e /tmp/writer-ready ] && return 0; sleep 0.1; done
  fail "WAL writer did not start"
}

newest() { find "$LUADY_HOME/backups" -maxdepth 1 -name "$1" | sort | tail -n1; }

check() {
  local db count
  count="$(find "$LUADY_HOME/backups" -maxdepth 1 -name 'luady-*.db.gz' | wc -l)"
  [ "$count" -eq 14 ] || fail "expected 14 database backups, found $count"
  count="$(find "$LUADY_HOME/backups" -maxdepth 1 -name 'brain-*.tgz' | wc -l)"
  [ "$count" -eq 14 ] || fail "expected 14 brain backups, found $count"
  [ -z "$(find "$LUADY_HOME/backups" -name '.*partial*')" ] || fail "stale partial file left behind"
  [ ! -e "$LUADY_HOME/backups/luady-20260101T000000Z.db.gz" ] || fail "oldest backup not pruned"
  db="$(newest 'luady-*.db.gz')"
  gunzip -c "$db" > /tmp/restored.db
  python3 - /tmp/restored.db <<'PY' || fail "restored database is incomplete"
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
assert db.execute('SELECT COUNT(*) FROM t').fetchone()[0] == 500
PY
  tar -tzf "$(newest 'brain-*.tgz')" | grep -qx 'brain/memory/USER.md' || fail "brain tarball lacks memory/USER.md"
  [ "$(stat -c %a "$db")" = 600 ] || fail "backup file is not 0600"
  [ "$(stat -c %a "$LUADY_HOME/backups")" = 700 ] || fail "backup dir is not 0700"
}

main() {
  seed
  hold_wal_writer
  bash /work/deploy/backup.sh
  kill "$WRITER" 2>/dev/null || true
  check
  echo "BACKUP TEST OK"
}

main "$@"
