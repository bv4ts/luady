/** The one pinned "Running now" board message (row id 1) and what it shows apart from the clock (`shown`). */
export const sql = `CREATE TABLE board (
  id INTEGER PRIMARY KEY CHECK (id = 1), chat_msg_id TEXT NOT NULL, sent_at TEXT NOT NULL, shown TEXT NOT NULL
);`;
