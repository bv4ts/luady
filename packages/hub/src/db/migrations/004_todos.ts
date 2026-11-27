/** The owner's to-do list and the 24 h pinned "today" boards. */
export const sql = `CREATE TABLE todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, today INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, done_at TEXT
);
CREATE TABLE todo_boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_msg_id TEXT, sent_at TEXT, pinned_at TEXT NOT NULL,
  reminded INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0
);`;
