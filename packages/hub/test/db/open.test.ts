import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/core/contracts.js';
import { ValidationError } from '../../src/core/errors.js';
import { openDb, openMemoryDb } from '../../src/db/open.js';
import { createQuestionsRepo } from '../../src/questions/repo.js';

let dir = '';
const opened: Db[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'luady-db-'));
});

afterEach(() => {
  for (const db of opened.splice(0)) {
    db.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

function track(db: Db): Db {
  opened.push(db);
  return db;
}

describe('openDb', () => {
  it('creates missing parent directories, enables WAL, foreign keys and busy timeout, and migrates', () => {
    const file = join(dir, 'nested', 'deeper', 'hub.db');
    const db = track(openDb(file));
    expect(existsSync(file)).toBe(true);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(db.prepare('SELECT version FROM schema_migrations').all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }, { version: 12 }, { version: 13 }, { version: 14 }, { version: 15 }, { version: 16 }]);
  });

  it('reopens an existing file without re-running migrations and keeps its data', () => {
    const file = join(dir, 'hub.db');
    const first = openDb(file);
    first.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run('away', 'true');
    first.close();
    const second = track(openDb(file));
    expect(second.prepare('SELECT value_json FROM settings WHERE key = ?').get('away')).toEqual({ value_json: 'true' });
    expect(second.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: 16 });
  });

  it('closes the connection and rethrows when migration fails', () => {
    const file = join(dir, 'broken.db');
    const raw = new Database(file);
    raw.exec('CREATE TABLE servers (legacy TEXT)');
    raw.close();
    expect(() => openDb(file)).toThrow(/migration 1 failed/);
    expect(() => rmSync(file)).not.toThrow();
  });

  it.each(['', '   ', ':memory:'])('rejects %j with ValidationError', (file) => {
    expect(() => openDb(file)).toThrow(ValidationError);
  });
});

describe('openMemoryDb', () => {
  it('returns a migrated in-memory database with foreign keys on', () => {
    const db = track(openMemoryDb());
    expect(db.pragma('journal_mode', { simple: true })).toBe('memory');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT hash FROM pin_state WHERE id = 1').get()).toEqual({ hash: null });
  });
});

describe('secure delete', () => {
  it('is on for a database file and an in-memory database', () => {
    expect(track(openDb(join(dir, 'hub.db'))).pragma('secure_delete', { simple: true })).toBe(1);
    expect(track(openMemoryDb()).pragma('secure_delete', { simple: true })).toBe(1);
  });

  it('a dropped permission preview cannot be read back from the database file', () => {
    const file = join(dir, 'hub.db');
    const db = track(openDb(file));
    const repo = createQuestionsRepo(db);
    const marker = 'SECRET-PREVIEW-MARKER-7f3a9c';
    repo.insert({
      qid: 'ABCDEFGH', kind: 'permission', host: 'cedar', sessionId: 'cedar:cc-x:0.0', createdAt: '2026-11-14T08:00:00.000Z',
      payload: {
        label: 'cedar · x', questions: [], toolName: 'Bash', inputPreview: 'npm test', toolUseId: null, claudeSessionId: null,
        preview: {
          tool: 'Bash', kind: 'command', command: `echo ${marker.repeat(40)}`, path: null, cwd: null, edits: [], truncated: false, always: null,
        },
      },
    });
    db.pragma('wal_checkpoint(TRUNCATE)');
    expect(readFileSync(file).includes(marker)).toBe(true);
    repo.dropPreview('ABCDEFGH', 'cedar');
    db.pragma('wal_checkpoint(TRUNCATE)');
    expect(readFileSync(file).includes(marker)).toBe(false);
  });
});

