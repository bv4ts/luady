/** Initial schema. Never edit after release; add 002_*.ts and list it in migrate.ts instead. */
export const sql = `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);

CREATE TABLE servers (
  name TEXT PRIMARY KEY, host TEXT NOT NULL, user TEXT NOT NULL, host_key_fp TEXT,
  status TEXT NOT NULL DEFAULT 'connecting', last_seen_at TEXT, sysinfo_json TEXT,
  kit_version TEXT, claude_version TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, host TEXT NOT NULL, tmux_target TEXT NOT NULL, claude_session_id TEXT,
  transcript_path TEXT, cwd TEXT, project TEXT, display_name TEXT NOT NULL, state TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'owner', registered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, last_event_at TEXT, turn_started_at TEXT,
  turn_remote INTEGER NOT NULL DEFAULT 0, pending_qid TEXT, unexpected_end INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_host ON sessions(host);
CREATE INDEX idx_sessions_claude ON sessions(claude_session_id);

CREATE TABLE events (
  id TEXT PRIMARY KEY, host TEXT NOT NULL, session_id TEXT, type TEXT NOT NULL,
  ts TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE INDEX idx_events_session_ts ON events(session_id, ts);
CREATE INDEX idx_events_ts ON events(ts);

CREATE TABLE questions (
  qid TEXT PRIMARY KEY, kind TEXT NOT NULL, host TEXT NOT NULL, session_id TEXT NOT NULL,
  payload_json TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL,
  notified_at TEXT, escalated_at TEXT, resolved_at TEXT, answer_json TEXT, resolved_via TEXT
);
CREATE INDEX idx_questions_state ON questions(state);

CREATE TABLE actions (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, actor TEXT NOT NULL, channel TEXT NOT NULL,
  kind TEXT NOT NULL, tier INTEGER NOT NULL, summary TEXT NOT NULL, params_json TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, decided_at TEXT, executed_at TEXT,
  result_text TEXT, error TEXT
);
CREATE INDEX idx_actions_status ON actions(status);

CREATE TABLE messages (
  id TEXT PRIMARY KEY, thread TEXT NOT NULL, role TEXT NOT NULL, channel TEXT,
  text TEXT NOT NULL, ts TEXT NOT NULL, ext_id TEXT
);
CREATE INDEX idx_messages_thread_ts ON messages(thread, ts);
CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rowid');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TABLE channel_links (
  channel TEXT NOT NULL, msg_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (channel, msg_id)
);
CREATE TABLE channel_seen (channel TEXT NOT NULL, msg_id TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (channel, msg_id));

CREATE TABLE injections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, text_sha256 TEXT NOT NULL,
  channel TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_injections_session ON injections(session_id, created_at);

CREATE TABLE projects (
  server TEXT NOT NULL, path TEXT NOT NULL, name TEXT NOT NULL, git_json TEXT NOT NULL,
  stack_json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (server, path)
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE offsets (host TEXT PRIMARY KEY, file TEXT NOT NULL, offset INTEGER NOT NULL);

CREATE TABLE auth_passkeys (
  cred_id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
  transports_json TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE TABLE auth_sessions (sid TEXT PRIMARY KEY, csrf TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE TABLE auth_challenges (id TEXT PRIMARY KEY, challenge TEXT NOT NULL, purpose TEXT NOT NULL, expires_at TEXT NOT NULL);

CREATE TABLE pin_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), hash TEXT, failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT, lockouts INTEGER NOT NULL DEFAULT 0
);
INSERT INTO pin_state (id) VALUES (1);

CREATE TABLE setup_codes (code_sha256 TEXT PRIMARY KEY, purpose TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);

CREATE TABLE schedules (
  id TEXT PRIMARY KEY, when_spec TEXT NOT NULL, task TEXT NOT NULL, next_run_at TEXT,
  created_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE manager_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, channel TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE manager_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), claude_session_id TEXT, started_at TEXT, last_input_channel TEXT
);
INSERT INTO manager_state (id) VALUES (1);
`;
