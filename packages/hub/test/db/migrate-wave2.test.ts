import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/core/contracts.js';
import { MIGRATIONS, migrate } from '../../src/db/migrate.js';

const opened: Db[] = [];
const AT = '2026-11-15T09:00:00.000Z';

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

/** A database with migrations 1–13 applied and recorded, as it stood before the links table. */
function waveOneDb(): Db {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter((m) => m.version <= 13)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, AT);
  }
  return db;
}

describe('migration 014 (links)', () => {
  it('runs on a database at migration 13 (with 015 and 016) and creates the links table', () => {
    const db = waveOneDb();
    db.prepare("INSERT INTO todos (text, today, done, created_at) VALUES ('Kept', 0, 0, ?)").run(AT);
    expect(migrate(db)).toBe(3);
    const columns = db.prepare<[], { name: string }>('PRAGMA table_info(links)').all().map((row) => row.name);
    expect(columns).toEqual(['id', 'server', 'label', 'url', 'position', 'created_at']);
    expect(db.prepare('SELECT text FROM todos').all()).toEqual([{ text: 'Kept' }]);
  });

  it('numbers links and orders them per office', () => {
    const db = waveOneDb();
    migrate(db);
    const insert = db.prepare('INSERT INTO links (server, label, url, position, created_at) VALUES (?, ?, ?, ?, ?)');
    insert.run('birch', 'Staging', 'https://staging.example', 1, AT);
    insert.run('birch', 'Jira', 'https://orchard-demo.atlassian.net', 0, AT);
    insert.run('cedar', 'GitHub', 'https://github.com/meadow', 0, AT);
    const birch = db.prepare<[string], { id: number; label: string }>('SELECT id, label FROM links WHERE server = ? ORDER BY position').all('birch');
    expect(birch).toEqual([{ id: 2, label: 'Jira' }, { id: 1, label: 'Staging' }]);
    expect(db.prepare('SELECT position FROM links WHERE id = 3').get()).toEqual({ position: 0 });
    expect(() => db.prepare('INSERT INTO links (server, label, url, created_at) VALUES (?, ?, ?, ?)').run('ash', 'x', 'https://x.example', AT)).not.toThrow();
    expect(() => db.prepare('INSERT INTO links (server, label, created_at) VALUES (?, ?, ?)').run('ash', 'x', AT)).toThrow(/NOT NULL/);
  });
});

describe('migration 015 (notes opened)', () => {
  it('adds opened_at; history and meetings older than a day count as opened, the last day stays new', () => {
    const db = waveOneDb();
    const insert = db.prepare(`INSERT INTO meetings (id, title, title_key, started_at, state, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    insert.run('old', 'Old', 'old', hoursAgo(30), 'announced', hoursAgo(29));
    insert.run('recent', 'Recent', 'recent', hoursAgo(3), 'announced', hoursAgo(2));
    insert.run('waiting', 'Waiting', 'waiting', hoursAgo(1), 'waiting', hoursAgo(1));
    insert.run('hist', 'Hist', 'hist', hoursAgo(2), 'history', hoursAgo(2));
    migrate(db);
    const rows = db.prepare<[], { id: string; opened: number }>('SELECT id, opened_at IS NOT NULL AS opened FROM meetings ORDER BY id').all();
    expect(rows).toEqual([{ id: 'hist', opened: 1 }, { id: 'old', opened: 1 }, { id: 'recent', opened: 0 }, { id: 'waiting', opened: 0 }]);
  });
});
