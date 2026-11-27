/** Nightly jobs (graphify, digest, brain rotation): the owner day each one last completed. */
export const sql = `CREATE TABLE daily_runs (job TEXT PRIMARY KEY, day TEXT NOT NULL, ran_at TEXT NOT NULL);`;
