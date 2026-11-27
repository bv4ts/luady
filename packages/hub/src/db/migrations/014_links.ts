/** The owner's quick links per office (the links shelf). Additive only. */
export const sql = `CREATE TABLE links (
  id INTEGER PRIMARY KEY AUTOINCREMENT, server TEXT NOT NULL, label TEXT NOT NULL, url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX idx_links_server ON links(server, position);`;
