import type { Db } from '../core/contracts.js';
import { sealer } from '../core/seal.js';
import { secretsMismatch } from './refusals.js';

/**
 * The columns that hold values sealed with SESSION_SECRET (core/seal.ts): Google refresh tokens, the Wispr refresh
 * token and Jira API tokens. Table and column names are constants, never input.
 */
export const SEALED_COLUMNS: ReadonlyArray<{ readonly table: string; readonly column: string }> = Object.freeze([
  { table: 'google_accounts', column: 'refresh_enc' },
  { table: 'wispr_auth', column: 'refresh_enc' },
  { table: 'jira_sites', column: 'token_enc' },
]);

function tableExists(db: Db, table: string): boolean {
  return db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.n === 1;
}

/** One sealed value of each table that has one. */
function samples(db: Db): string[] {
  return SEALED_COLUMNS.flatMap(({ table, column }) => {
    if (!tableExists(db, table)) return [];
    const row = db.prepare<[], { v: unknown }>(`SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL AND ${column} <> '' LIMIT 1`).get();
    return typeof row?.v === 'string' ? [row.v] : [];
  });
}

/**
 * When any sealed row exists, one decrypt per table must succeed with this
 * SESSION_SECRET. A secrets file of another install (a wrong LUADY_SECRETS, a regenerated secret) is refused before
 * anything can overwrite the tokens. Nothing is logged: neither the secret nor the plaintext leaves this function.
 */
export function probeSealed(db: Db, secret: string): void {
  const box = sealer(secret);
  for (const sealed of samples(db)) {
    try {
      box.open(sealed);
    } catch {
      throw secretsMismatch();
    }
  }
}
