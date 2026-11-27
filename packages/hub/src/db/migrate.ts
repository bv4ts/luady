import type { Db } from '../core/contracts.js';
import { sql as initSql } from './migrations/001_init.js';
import { sql as dailySql } from './migrations/002_daily_runs.js';
import { sql as missionsSql } from './migrations/003_missions.js';
import { sql as todosSql } from './migrations/004_todos.js';
import { sql as googleSql } from './migrations/005_google.js';
import { sql as boardSql } from './migrations/006_board.js';
import { sql as loginAlertsSql } from './migrations/007_login_alerts.js';
import { sql as meetingsSql } from './migrations/008_meetings.js';
import { sql as wisprRedirectSql } from './migrations/009_wispr_redirect.js';
import { sql as noticesSql } from './migrations/010_notices.js';
import { sql as accountLimitsSql } from './migrations/011_account_limits.js';
import { sql as boardNotesSql } from './migrations/012_board_notes.js';
import { sql as kbJiraSql } from './migrations/013_kb_jira.js';
import { sql as linksSql } from './migrations/014_links.js';
import { sql as notesOpenedSql } from './migrations/015_notes_opened.js';
import { sql as p1Sql } from './migrations/016_p1.js';

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: initSql }, { version: 2, sql: dailySql }, { version: 3, sql: missionsSql }, { version: 4, sql: todosSql },
  { version: 5, sql: googleSql }, { version: 6, sql: boardSql }, { version: 7, sql: loginAlertsSql },
  { version: 8, sql: meetingsSql }, { version: 9, sql: wisprRedirectSql }, { version: 10, sql: noticesSql },
  { version: 11, sql: accountLimitsSql }, { version: 12, sql: boardNotesSql }, { version: 13, sql: kbJiraSql },
  { version: 14, sql: linksSql }, { version: 15, sql: notesOpenedSql }, { version: 16, sql: p1Sql },
];

const LEDGER_DDL =
  'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)';

/** Applies every migration not yet recorded in schema_migrations, each in its own transaction. Returns how many ran. */
export function migrate(db: Db): number {
  db.exec(LEDGER_DDL);
  const applied = new Set(
    db
      .prepare<[], { version: number }>('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row.version),
  );
  const pending = MIGRATIONS.filter((migration) => !applied.has(migration.version));
  for (const migration of pending) {
    applyMigration(db, migration);
  }
  return pending.length;
}

function applyMigration(db: Db, migration: Migration): void {
  const record = db.prepare<[number, string]>('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  const run = db.transaction(() => {
    db.exec(migration.sql);
    record.run(migration.version, new Date().toISOString());
  });
  try {
    run();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`migration ${migration.version} failed: ${reason}`, { cause: err });
  }
}
