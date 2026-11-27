/** Pinned mission status messages (one row per open mission, deleted when it is done). */
export const sql = `CREATE TABLE missions (
  session_id TEXT PRIMARY KEY, label TEXT NOT NULL, title TEXT NOT NULL, phase TEXT NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0, note TEXT, last_text TEXT, managed INTEGER NOT NULL DEFAULT 0,
  chat_msg_id TEXT, sent_at TEXT, opened_at TEXT NOT NULL, idle_since TEXT
);`;
