import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/core/contracts.js';
import { MIGRATIONS, migrate } from '../../src/db/migrate.js';
import { createServersRepo } from '../../src/fleet/servers-repo.js';

const AT = '2026-11-21T08:00:00.000Z';
const SWITCHES = ['brief_enabled', 'claude_update_enabled', 'digest_enabled', 'graphify_enabled', 'manager_enabled', 'tools_update_enabled'];
const opened: Db[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

/** A database at version 15, the way an existing install has it before this release. */
function v15(): Db {
  const db = new Database(':memory:');
  opened.push(db);
  db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter((m) => m.version <= 15)) {
    db.exec(migration.sql);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, AT);
  }
  return db;
}

const passkey = (db: Db): void => {
  db.prepare(`INSERT INTO auth_passkeys (cred_id, public_key, counter, transports_json, label, created_at)
    VALUES ('cred-1', x'00', 0, '[]', 'Phone', ?)`).run(AT);
};
const switches = (db: Db): string[] => db.prepare<[], { key: string }>(
  `SELECT key FROM settings WHERE key IN (${SWITCHES.map(() => '?').join(', ')}) AND value_json = 'true' ORDER BY key`,
).all(...SWITCHES as []).map((row) => row.key);
const setupStep = (db: Db): unknown => db.prepare('SELECT id, step, skipped_json, completed_at FROM setup_state').all();

describe('migration 016', () => {
  it('an existing install (with a passkey) starts at setup done with the six switches on', () => {
    const db = v15();
    passkey(db);
    expect(migrate(db)).toBe(1);
    expect(setupStep(db)).toEqual([{ id: 1, step: 'done', skipped_json: '[]', completed_at: null }]);
    expect(switches(db)).toEqual(SWITCHES);
  });

  it('a new install starts at claim with no switch rows (the defaults are off)', () => {
    const db = v15();
    migrate(db);
    expect(setupStep(db)).toEqual([{ id: 1, step: 'claim', skipped_json: '[]', completed_at: null }]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE key IN (${SWITCHES.map(() => '?').join(', ')})`).get(...SWITCHES as []))
      .toEqual({ n: 0 });
  });

  it('keeps a switch the owner already stored', () => {
    const db = v15();
    passkey(db);
    db.prepare("INSERT INTO settings (key, value_json) VALUES ('digest_enabled', 'false')").run();
    migrate(db);
    expect(switches(db)).toEqual(SWITCHES.filter((key) => key !== 'digest_enabled'));
  });

  it('old servers rows read as config-sourced, pinned SSH hosts on port 22, and still parse', () => {
    const db = v15();
    db.prepare(`INSERT INTO servers (name, host, user, host_key_fp, status) VALUES ('cedar', 'cedar.example.invalid', 'dev', 'SHA256:x', 'online')`).run();
    migrate(db);
    expect(db.prepare('SELECT kind, port, source, state, projects_root, home_dir, removed_at FROM servers').get()).toEqual({
      kind: 'ssh', port: 22, source: 'config', state: 'pinned', projects_root: null, home_dir: null, removed_at: null,
    });
    expect(createServersRepo(db).get('cedar')).toMatchObject({ name: 'cedar', kind: 'ssh', projectsRoot: null, homeDir: null, terminal: true });
  });

  it('adds the page key hash to sessions and the rooms table with its constraints', () => {
    const db = v15();
    migrate(db);
    const sessionColumns = db.prepare<[], { name: string }>('PRAGMA table_info(auth_sessions)').all().map((row) => row.name);
    expect(sessionColumns).toContain('page_key_sha256');
    const insert = db.prepare(`INSERT INTO rooms (id, name, short, kind, host, colour, accent, species, position, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '#d6336c', '#e88fae', 'bun', ?, ?, ?)`);
    insert.run('orchard', 'Orchard', 'Orchard', 'server', 'birch', 0, AT, AT);
    insert.run('shop', 'Shop', 'Shop', 'project', 'birch', 1, AT, AT);
    expect(() => insert.run('orchard-2', 'Orchard Two', 'O2', 'server', 'birch', 2, AT, AT)).toThrow(/UNIQUE/);
    expect(() => insert.run('other', 'ORCHARD', 'O', 'project', null, 3, AT, AT)).toThrow(/UNIQUE/);
    expect(() => insert.run('neg', 'Neg', 'N', 'project', null, -1, AT, AT)).toThrow(/CHECK/);
    expect(() => insert.run('dup', 'Dup', 'D', 'project', null, 1, AT, AT)).toThrow(/UNIQUE/);
    expect(() => insert.run('bad', 'Bad', 'B', 'office', null, 4, AT, AT)).toThrow(/CHECK/);
    expect(db.prepare('SELECT size, match_json FROM rooms WHERE id = ?').get('orchard')).toEqual({ size: 'm', match_json: '[]' });
  });

  it('keeps the stored settings and records version 16 (the round trip over 001-016 is in name-map.test.ts)', () => {
    const db = v15();
    passkey(db);
    db.prepare("INSERT INTO settings (key, value_json) VALUES ('manager_model', '\"sonnet\"')").run();
    migrate(db);
    expect(db.prepare("SELECT value_json FROM settings WHERE key = 'manager_model'").get()).toEqual({ value_json: '"sonnet"' });
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: 16 });
  });
});
