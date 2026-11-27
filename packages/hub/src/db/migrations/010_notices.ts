/**
 * Things Luady or the hub told the owner (notices/repo.ts). Each row carries its own chat fallback time, so a
 * restart loses nothing. Additive only: the `board` table of 006 stays (a rolled-back release still reads it).
 */
export const sql = `CREATE TABLE notices (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, ref_kind TEXT, ref_id TEXT,
  created_at TEXT NOT NULL, chat_due_at TEXT, chat_sent_at TEXT, chat_msg_id TEXT, settled_at TEXT, settled_via TEXT
);
CREATE INDEX idx_notices_created ON notices(created_at);
CREATE INDEX idx_notices_due ON notices(chat_due_at);
CREATE INDEX idx_notices_ref ON notices(ref_kind, ref_id);`;
