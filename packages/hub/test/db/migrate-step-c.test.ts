import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/core/contracts.js';
import { MIGRATIONS, migrate } from '../../src/db/migrate.js';

const opened: Db[] = [];
const AT = '2026-11-15T09:00:00.000Z';

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

/** A database with migrations 1–11 applied and recorded, as it stood before the board and notes tables. */
function stepBDb(): Db {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter((m) => m.version <= 11)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, AT);
  }
  return db;
}

function columns(db: Db, table: string): string[] {
  return db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

describe('migration 012 (board and notes)', () => {
  it('turns existing to-dos into cards: done rows done, the rest open', () => {
    const db = stepBDb();
    db.prepare("INSERT INTO todos (text, today, done, created_at, done_at) VALUES ('Buy milk', 1, 0, ?, NULL)").run(AT);
    db.prepare("INSERT INTO todos (text, today, done, created_at, done_at) VALUES ('Call Sara', 0, 1, ?, '2026-11-15T10:00:00.000Z')").run(AT);
    expect(migrate(db)).toBe(MIGRATIONS.filter((m) => m.version > 11).length);
    const rows = db.prepare('SELECT text, state, source, details, priority, auto, updated_at FROM todos ORDER BY id').all();
    expect(rows).toEqual([
      { text: 'Buy milk', state: 'open', source: 'manager', details: '', priority: 0, auto: 0, updated_at: AT },
      { text: 'Call Sara', state: 'done', source: 'manager', details: '', priority: 0, auto: 0, updated_at: '2026-11-15T10:00:00.000Z' },
    ]);
  });

  it('adds every card column and keeps done and done_at for a rolled-back release', () => {
    const db = stepBDb();
    migrate(db);
    expect(columns(db, 'todos')).toEqual([
      'id', 'text', 'today', 'done', 'created_at', 'done_at', 'details', 'project', 'server', 'source', 'source_ref', 'state',
      'priority', 'auto', 'run_id', 'session_id', 'result', 'updated_at', 'due_at', 'snooze_until',
    ]);
    // The to-do service's own statements still work.
    db.prepare('INSERT INTO todos (text, today, done, created_at) VALUES (?, ?, 0, ?)').run('Old release', 0, AT);
    expect(db.prepare("SELECT state FROM todos WHERE text = 'Old release'").get()).toEqual({ state: 'open' });
    expect(() => db.prepare('UPDATE todos SET done = 1, done_at = ? WHERE id = ?').run(AT, 1)).not.toThrow();
  });

  it('creates the card log and the message references', () => {
    const db = stepBDb();
    migrate(db);
    expect(columns(db, 'todo_events')).toEqual(['id', 'todo_id', 'at', 'kind', 'text']);
    expect(columns(db, 'message_refs')).toEqual(['message_id', 'ref_kind', 'ref_id']);
    db.prepare("INSERT INTO message_refs VALUES ('m1', 'note', 'n:1')").run();
    expect(() => db.prepare("INSERT INTO message_refs VALUES ('m1', 'todo', '2')").run()).toThrow(/UNIQUE/);
  });

  it('keeps notes_fts in step with notes on insert, update and delete', () => {
    const db = stepBDb();
    migrate(db);
    const hits = (term: string): number[] => db
      .prepare<[string], { id: number }>('SELECT rowid AS id FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rowid')
      .all(term)
      .map((row) => row.id);
    const insert = db.prepare('INSERT INTO notes (title, body, project, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('Stand-up', 'Login is done, checkout next', 'orchard', AT, AT);
    insert.run('Ideas', 'A pond in the garden', null, AT, AT);
    expect(hits('checkout')).toEqual([1]);
    expect(hits('orchard')).toEqual([1]);
    db.prepare("UPDATE notes SET body = 'Checkout shipped, pond next' WHERE id = 1").run();
    expect(hits('pond')).toEqual([1, 2]);
    db.prepare('DELETE FROM notes WHERE id = 2').run();
    expect(hits('pond')).toEqual([1]);
  });
});

describe('migration 013 (knowledge base and Jira)', () => {
  it('keeps one page per slug in each scope, server and project (global pages too)', () => {
    const db = stepBDb();
    migrate(db);
    const insert = db.prepare(
      "INSERT INTO kb_pages (scope, server, project, slug, title, body, updated_at, updated_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'owner', ?)",
    );
    insert.run('global', '', '', 'rules', 'Rules', 'Be kind', AT, AT);
    expect(() => insert.run('global', '', '', 'rules', 'Rules again', '', AT, AT)).toThrow(/UNIQUE/);
    expect(() => insert.run('project', 'birch', 'orchard', 'rules', 'Rules', '', AT, AT)).not.toThrow();
    expect(db.prepare('SELECT tags, pinned, auto FROM kb_pages WHERE id = 1').get()).toEqual({ tags: '[]', pinned: 0, auto: 0 });
  });

  it('keeps kb_pages_fts in step with kb_pages', () => {
    const db = stepBDb();
    migrate(db);
    db.prepare(
      "INSERT INTO kb_pages (scope, slug, title, body, updated_at, updated_by, created_at) VALUES ('global', 'deploy', 'Deploy', 'Run the migrations first', ?, 'manager', ?)",
    ).run(AT, AT);
    const count = (term: string): unknown => db.prepare('SELECT COUNT(*) AS n FROM kb_pages_fts WHERE kb_pages_fts MATCH ?').get(term);
    expect(count('migrations')).toEqual({ n: 1 });
    db.prepare("UPDATE kb_pages SET body = 'Seed the cache' WHERE id = 1").run();
    expect(count('migrations')).toEqual({ n: 0 });
    db.prepare('DELETE FROM kb_pages WHERE id = 1').run();
    expect(count('cache')).toEqual({ n: 0 });
  });

  it('creates the sync record and the Jira tables with their keys', () => {
    const db = stepBDb();
    migrate(db);
    expect(columns(db, 'kb_sync')).toEqual(['server', 'synced_at', 'digest']);
    expect(columns(db, 'jira_sites')).toEqual([
      'server', 'base_url', 'email', 'token_enc', 'cloud_id', 'account_id', 'display_name', 'connected_at', 'last_ok_at', 'last_error',
    ]);
    db.prepare("INSERT INTO jira_seen VALUES ('birch', 'ORC-1', ?)").run(AT);
    expect(() => db.prepare("INSERT INTO jira_seen VALUES ('birch', 'ORC-1', ?)").run(AT)).toThrow(/UNIQUE/);
    expect(() => db.prepare("INSERT INTO jira_seen VALUES ('cedar', 'ORC-1', ?)").run(AT)).not.toThrow();
  });
});
