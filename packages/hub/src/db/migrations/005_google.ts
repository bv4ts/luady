/** Connected Google accounts (sealed refresh tokens) and what was already alerted/reminded. */
export const sql = `CREATE TABLE google_accounts (
  email TEXT PRIMARY KEY, label TEXT NOT NULL, refresh_enc TEXT NOT NULL, added_at TEXT NOT NULL, primed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE google_seen (account TEXT NOT NULL, item TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (account, item));
CREATE INDEX idx_google_seen_at ON google_seen(seen_at);`;
