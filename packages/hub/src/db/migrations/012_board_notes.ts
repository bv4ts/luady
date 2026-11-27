/**
 * The board grows out of the to-do list, card logs, what a chat message is about, and typed notes.
 * Additive only: `done` and `done_at` stay and are kept in step with `state`, so the previous release still works.
 * Existing rows become `done` where done = 1, else `open`. `updated_at` starts as the time the row last changed.
 */
export const sql = `ALTER TABLE todos ADD COLUMN details TEXT NOT NULL DEFAULT '';
ALTER TABLE todos ADD COLUMN project TEXT;
ALTER TABLE todos ADD COLUMN server TEXT;
ALTER TABLE todos ADD COLUMN source TEXT NOT NULL DEFAULT 'manager';
ALTER TABLE todos ADD COLUMN source_ref TEXT;
ALTER TABLE todos ADD COLUMN state TEXT NOT NULL DEFAULT 'open';
ALTER TABLE todos ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE todos ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
ALTER TABLE todos ADD COLUMN run_id TEXT;
ALTER TABLE todos ADD COLUMN session_id TEXT;
ALTER TABLE todos ADD COLUMN result TEXT;
ALTER TABLE todos ADD COLUMN updated_at TEXT;
ALTER TABLE todos ADD COLUMN due_at TEXT;
ALTER TABLE todos ADD COLUMN snooze_until TEXT;
UPDATE todos SET state = CASE WHEN done = 1 THEN 'done' ELSE 'open' END, updated_at = COALESCE(done_at, created_at);
CREATE INDEX idx_todos_state ON todos(state, id);
CREATE INDEX idx_todos_session ON todos(session_id);
CREATE INDEX idx_todos_source ON todos(source, source_ref);
CREATE TABLE todo_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, todo_id INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_todo_events_todo ON todo_events(todo_id, id);
CREATE TABLE message_refs (message_id TEXT PRIMARY KEY, ref_kind TEXT NOT NULL, ref_id TEXT NOT NULL);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, project TEXT,
  source TEXT NOT NULL DEFAULT 'web', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_notes_created ON notes(created_at);
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, project, content='notes', content_rowid='id');
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body, project) VALUES (new.id, new.title, new.body, new.project);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body, project) VALUES ('delete', old.id, old.title, old.body, old.project);
END;
CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body, project) VALUES ('delete', old.id, old.title, old.body, old.project);
  INSERT INTO notes_fts(rowid, title, body, project) VALUES (new.id, new.title, new.body, new.project);
END;`;
