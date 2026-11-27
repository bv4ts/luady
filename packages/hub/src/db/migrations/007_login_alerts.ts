/** The last Claude-login warning sent per host: `alert` is 'out' (signed out) or the expiry it warned about. */
export const sql = `CREATE TABLE login_alerts (host TEXT PRIMARY KEY, alert TEXT NOT NULL, sent_at TEXT NOT NULL);`;
