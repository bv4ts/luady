import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/core/contracts.js';
import { migrate } from '../../src/db/migrate.js';

const C5_TABLES = [
  'account_limits',
  'actions',
  'auth_challenges',
  'auth_passkeys',
  'auth_sessions',
  'channel_links',
  'channel_seen',
  'events',
  'injections',
  'manager_queue',
  'manager_state',
  'messages',
  'messages_fts',
  'notices',
  'offsets',
  'pin_state',
  'projects',
  'questions',
  'schedules',
  'schema_migrations',
  'servers',
  'sessions',
  'settings',
  'setup_codes',
];
const C5_INDEXES = [
  'idx_actions_status',
  'idx_events_session_ts',
  'idx_events_ts',
  'idx_google_seen_at',
  'idx_injections_session',
  'idx_links_server',
  'idx_meetings_started',
  'idx_meetings_title_key',
  'idx_messages_thread_ts',
  'idx_notes_created',
  'idx_notices_created',
  'idx_notices_due',
  'idx_notices_ref',
  'idx_questions_state',
  'idx_rooms_home',
  'idx_rooms_host',
  'idx_rooms_name',
  'idx_sessions_claude',
  'idx_sessions_host',
  'idx_todo_events_todo',
  'idx_todos_session',
  'idx_todos_source',
  'idx_todos_state',
];
// "مرحبا يا صديقي، تم النشر" and "صديقي" as escapes.
const ARABIC_MESSAGE =
  '\u0645\u0631\u062d\u0628\u0627 \u064a\u0627 \u0635\u062f\u064a\u0642\u064a\u060c \u062a\u0645 \u0627\u0644\u0646\u0634\u0631';
const ARABIC_TERM = '\u0635\u062f\u064a\u0642\u064a';

const opened: Db[] = [];

function freshDb(): Db {
  const db = new Database(':memory:');
  opened.push(db);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) {
    db.close();
  }
});

function names(db: Db, type: 'table' | 'index' | 'trigger'): string[] {
  return db
    .prepare<[string], { name: string }>('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
    .all(type)
    .map((row) => row.name);
}

function insertMessage(db: Db, id: string, text: string): void {
  db.prepare('INSERT INTO messages (id, thread, role, channel, text, ts, ext_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    'manager',
    'owner',
    'test-channel',
    text,
    '2026-10-09T12:00:00.000Z',
    null,
  );
}

function search(db: Db, query: string): string[] {
  return db
    .prepare<[string], { id: string }>(
      'SELECT m.id AS id FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH ? ORDER BY m.id',
    )
    .all(query)
    .map((row) => row.id);
}

describe('migrate', () => {
  it('creates every table', () => {
    const db = freshDb();
    migrate(db);
    expect(names(db, 'table')).toEqual(expect.arrayContaining(C5_TABLES));
  });

  it('creates the indexes and the FTS sync triggers', () => {
    const db = freshDb();
    migrate(db);
    expect(names(db, 'index').filter((name) => name.startsWith('idx_'))).toEqual(C5_INDEXES);
    expect(names(db, 'trigger')).toEqual([
      'kb_pages_ad', 'kb_pages_ai', 'kb_pages_au', 'meetings_ad', 'meetings_ai', 'meetings_au', 'messages_ad', 'messages_ai',
      'notes_ad', 'notes_ai', 'notes_au',
    ]);
  });

  it('returns the migration count on a fresh database and 0 on every later run', () => {
    const db = freshDb();
    expect(migrate(db)).toBe(16);
    expect(migrate(db)).toBe(0);
    expect(migrate(db)).toBe(0);
    const rows = db
      .prepare<[], { version: number; applied_at: string }>('SELECT version, applied_at FROM schema_migrations')
      .all();
    expect(rows).toHaveLength(16);
    expect(rows[0]?.version).toBe(1);
    expect(new Date(rows[0]?.applied_at ?? '').toISOString()).toBe(rows[0]?.applied_at);
  });

  it('keeps the board table: the previous release still prepares statements on it, and a rollback keeps the schema', () => {
    const db = freshDb();
    migrate(db);
    expect(names(db, 'table')).toContain('board');
    expect(() => db.prepare('SELECT chat_msg_id FROM board WHERE id = 1').get()).not.toThrow();
  });

  it('seeds the pin_state and manager_state singletons and enforces id = 1', () => {
    const db = freshDb();
    migrate(db);
    expect(db.prepare('SELECT * FROM pin_state').all()).toEqual([
      { id: 1, hash: null, failed_count: 0, locked_until: null, lockouts: 0 },
    ]);
    expect(db.prepare('SELECT * FROM manager_state').all()).toEqual([
      { id: 1, claude_session_id: null, started_at: null, last_input_channel: null },
    ]);
    expect(() => db.prepare('INSERT INTO pin_state (id) VALUES (2)').run()).toThrow(/CHECK constraint failed/);
    expect(() => db.prepare('INSERT INTO manager_state (id) VALUES (2)').run()).toThrow(/CHECK constraint failed/);
  });

  it('keeps messages_fts in sync on insert and delete (English and Arabic)', () => {
    const db = freshDb();
    migrate(db);
    insertMessage(db, 'm1', 'please deploy meadow-hr tonight');
    insertMessage(db, 'm2', ARABIC_MESSAGE);
    insertMessage(db, 'm3', 'Deployed. All 42 tests pass.');
    expect(search(db, 'deploy')).toEqual(['m1']);
    expect(search(db, 'deploy*')).toEqual(['m1', 'm3']);
    expect(search(db, ARABIC_TERM)).toEqual(['m2']);
    db.prepare('DELETE FROM messages WHERE id = ?').run('m1');
    expect(search(db, 'deploy*')).toEqual(['m3']);
  });

  it('rolls back a failed migration and names its version', () => {
    const db = freshDb();
    db.exec('CREATE TABLE servers (legacy TEXT)');
    expect(() => migrate(db)).toThrow(/migration 1 failed: table servers already exists/);
    expect(names(db, 'table')).toEqual(['schema_migrations', 'servers']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 0 });
  });
});
