import { describe, expect, it } from 'vitest';
import { StartupRefusal } from '../../src/config/refusals.js';
import { probeSealed } from '../../src/config/sealed-probe.js';
import { sealer } from '../../src/core/seal.js';
import { openMemoryDb } from '../../src/db/open.js';

const SECRET_A = 'a1'.repeat(32);
const SECRET_B = 'b2'.repeat(32);
const NOW = '2026-11-21T08:00:00.000Z';

function refusal(fn: () => void): StartupRefusal {
  try {
    fn();
  } catch (err) {
    if (err instanceof StartupRefusal) return err;
    throw err;
  }
  throw new Error('expected a startup refusal');
}

describe('the sealed-row probe', () => {
  it('a database sealed with secret A refuses to start under secret B, saying the secrets file does not belong to it', () => {
    const db = openMemoryDb();
    db.prepare('INSERT INTO google_accounts (email, label, refresh_enc, added_at) VALUES (?, ?, ?, ?)')
      .run('owner@example.com', 'work', sealer(SECRET_A).seal('refresh-token-value'), NOW);
    const error = refusal(() => probeSealed(db, SECRET_B));
    expect(error.refusal).toBe('secrets-mismatch');
    expect(error.message).toContain('this secrets file does not belong to this database');
    expect(error.message).not.toContain(SECRET_B);
    expect(error.message).not.toContain('refresh-token-value');
    expect(() => probeSealed(db, SECRET_A)).not.toThrow();
  });

  it('checks every sealed table: a Jira token or the Wispr token sealed with another secret is refused too', () => {
    const jira = openMemoryDb();
    jira.prepare('INSERT INTO jira_sites (server, base_url, email, token_enc, connected_at) VALUES (?, ?, ?, ?, ?)')
      .run('orchard', 'https://example.atlassian.net', 'owner@example.com', sealer(SECRET_A).seal('api-token'), NOW);
    expect(refusal(() => probeSealed(jira, SECRET_B)).refusal).toBe('secrets-mismatch');
    const wispr = openMemoryDb();
    wispr.prepare('INSERT INTO wispr_auth (id, client_id, refresh_enc, connected_at) VALUES (1, ?, ?, ?)')
      .run('client', sealer(SECRET_A).seal('wispr-token'), NOW);
    expect(refusal(() => probeSealed(wispr, SECRET_B)).refusal).toBe('secrets-mismatch');
    expect(() => probeSealed(wispr, SECRET_A)).not.toThrow();
  });

  it('a database with no sealed row starts under any secret (a new install)', () => {
    const db = openMemoryDb();
    db.prepare('INSERT INTO wispr_auth (id, client_id, refresh_enc) VALUES (1, NULL, NULL)').run();
    expect(() => probeSealed(db, SECRET_B)).not.toThrow();
  });

  it('a value that is not even a sealed blob counts as a mismatch, never as a crash', () => {
    const db = openMemoryDb();
    db.prepare('INSERT INTO google_accounts (email, label, refresh_enc, added_at) VALUES (?, ?, ?, ?)').run('owner@example.com', 'work', 'garbage', NOW);
    expect(refusal(() => probeSealed(db, SECRET_A)).refusal).toBe('secrets-mismatch');
  });
});
