/**
 * Knowledge pages and when they last reached each server, and Jira per office. Additive only.
 * kb_pages: `server` and `project` are '' when the scope has none (so the unique key also holds for global pages);
 * `tags` is a JSON array. jira_sites: `token_enc` is sealed like the Wispr token and never leaves the hub.
 */
export const sql = `CREATE TABLE kb_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, server TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '',
  slug TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0, auto INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL, UNIQUE (scope, server, project, slug)
);
CREATE VIRTUAL TABLE kb_pages_fts USING fts5(title, body, tags, content='kb_pages', content_rowid='id');
CREATE TRIGGER kb_pages_ai AFTER INSERT ON kb_pages BEGIN
  INSERT INTO kb_pages_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
CREATE TRIGGER kb_pages_ad AFTER DELETE ON kb_pages BEGIN
  INSERT INTO kb_pages_fts(kb_pages_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
CREATE TRIGGER kb_pages_au AFTER UPDATE ON kb_pages BEGIN
  INSERT INTO kb_pages_fts(kb_pages_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
  INSERT INTO kb_pages_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
END;
CREATE TABLE kb_sync (server TEXT PRIMARY KEY, synced_at TEXT, digest TEXT);
CREATE TABLE jira_sites (
  server TEXT PRIMARY KEY, base_url TEXT NOT NULL, email TEXT NOT NULL, token_enc TEXT NOT NULL, cloud_id TEXT, account_id TEXT,
  display_name TEXT, connected_at TEXT NOT NULL, last_ok_at TEXT, last_error TEXT
);
CREATE TABLE jira_seen (server TEXT NOT NULL, key TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (server, key));`;
