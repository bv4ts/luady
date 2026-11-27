/**
 * Wispr Flow sign-in (sealed refresh token) and every meeting Luady has seen, with a full-text index.
 * state: live (still recording) · waiting (ended, summary not ready) · announced · skipped (junk) · history (silent).
 */
export const sql = `CREATE TABLE wispr_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1), client_id TEXT, refresh_enc TEXT, connected_at TEXT, alerted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE meetings (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, title_key TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
  finalized INTEGER NOT NULL DEFAULT 0, shared INTEGER NOT NULL DEFAULT 0, people TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', todos TEXT NOT NULL DEFAULT '', gist TEXT NOT NULL DEFAULT '',
  project TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
);
CREATE INDEX idx_meetings_started ON meetings(started_at);
CREATE INDEX idx_meetings_title_key ON meetings(title_key, started_at);
CREATE VIRTUAL TABLE meetings_fts USING fts5(title, people, project, gist, summary, notes, content='meetings', content_rowid='rowid');
CREATE TRIGGER meetings_ai AFTER INSERT ON meetings BEGIN
  INSERT INTO meetings_fts(rowid, title, people, project, gist, summary, notes)
  VALUES (new.rowid, new.title, new.people, new.project, new.gist, new.summary, new.notes);
END;
CREATE TRIGGER meetings_ad AFTER DELETE ON meetings BEGIN
  INSERT INTO meetings_fts(meetings_fts, rowid, title, people, project, gist, summary, notes)
  VALUES ('delete', old.rowid, old.title, old.people, old.project, old.gist, old.summary, old.notes);
END;
CREATE TRIGGER meetings_au AFTER UPDATE ON meetings BEGIN
  INSERT INTO meetings_fts(meetings_fts, rowid, title, people, project, gist, summary, notes)
  VALUES ('delete', old.rowid, old.title, old.people, old.project, old.gist, old.summary, old.notes);
  INSERT INTO meetings_fts(rowid, title, people, project, gist, summary, notes)
  VALUES (new.rowid, new.title, new.people, new.project, new.gist, new.summary, new.notes);
END;`;
