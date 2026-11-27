/**
 * The newest plan-limit reading per host (accounts/limits.ts), fed by the kit's meter events. Additive only.
 * `reported`: 'yes' once any limit window arrived, 'no' after five readings without any, else 'unknown'.
 */
export const sql = `CREATE TABLE account_limits (
  host TEXT PRIMARY KEY, five_hour_json TEXT, seven_day_json TEXT, reported TEXT NOT NULL DEFAULT 'unknown',
  empty_readings INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);`;
