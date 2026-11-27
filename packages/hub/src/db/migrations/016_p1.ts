/**
 * Rooms, the first-run state, the hosts table (the servers table grows), the page
 * key's hash on a session, and the six background switches.
 *
 * - An existing install (one with a passkey) starts at setup step `done` and keeps the manager, the nightly summary,
 *   the morning brief, the Claude Code and tools updates and the code map on. A new install starts
 *   at `claim` with all six off (no rows: the settings defaults are off).
 * - Old servers rows read as config-sourced, pinned SSH hosts on port 22.
 * - The name index on rooms is an ASCII backstop; the rooms service checks Unicode case folding.
 */
export const sql = `CREATE TABLE rooms (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, short TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('server','project','local')),
  host TEXT, match_json TEXT NOT NULL DEFAULT '[]',
  colour TEXT NOT NULL, accent TEXT NOT NULL, species TEXT NOT NULL,
  position INTEGER NOT NULL UNIQUE CHECK (position >= 0), size TEXT NOT NULL DEFAULT 'm',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_rooms_name ON rooms(lower(name));
CREATE UNIQUE INDEX idx_rooms_home ON rooms(host) WHERE kind IN ('server','local');
CREATE INDEX idx_rooms_host ON rooms(host);

CREATE TABLE setup_state (id INTEGER PRIMARY KEY CHECK (id = 1), step TEXT NOT NULL, skipped_json TEXT NOT NULL DEFAULT '[]',
  completed_at TEXT, updated_at TEXT NOT NULL);
INSERT INTO setup_state SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM auth_passkeys) THEN 'done' ELSE 'claim' END, '[]', NULL, datetime('now');

ALTER TABLE servers ADD COLUMN kind TEXT NOT NULL DEFAULT 'ssh' CHECK (kind IN ('ssh','local'));
ALTER TABLE servers ADD COLUMN port INTEGER NOT NULL DEFAULT 22;
ALTER TABLE servers ADD COLUMN projects_root TEXT;
ALTER TABLE servers ADD COLUMN home_dir TEXT;
ALTER TABLE servers ADD COLUMN claude_bin TEXT;
ALTER TABLE servers ADD COLUMN from_addr TEXT;
ALTER TABLE servers ADD COLUMN source TEXT NOT NULL DEFAULT 'config' CHECK (source IN ('config','web'));
ALTER TABLE servers ADD COLUMN state TEXT NOT NULL DEFAULT 'pinned' CHECK (state IN ('draft','pinned','removed'));
ALTER TABLE servers ADD COLUMN created_at TEXT;
ALTER TABLE servers ADD COLUMN updated_at TEXT;
ALTER TABLE servers ADD COLUMN removed_at TEXT;

ALTER TABLE auth_sessions ADD COLUMN page_key_sha256 TEXT;

INSERT OR IGNORE INTO settings (key, value_json)
  SELECT k, 'true' FROM (SELECT 'manager_enabled' k UNION ALL SELECT 'digest_enabled' UNION ALL SELECT 'brief_enabled'
    UNION ALL SELECT 'claude_update_enabled' UNION ALL SELECT 'tools_update_enabled' UNION ALL SELECT 'graphify_enabled')
  WHERE EXISTS (SELECT 1 FROM auth_passkeys);`;
