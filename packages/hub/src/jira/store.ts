import { isRoomId, type HostId } from '@luady/shared';
import type { Db, Logger } from '../core/contracts.js';

/** jira_sites and jira_seen (migration 013). `tokenEnc` is sealed; it never leaves this module except to be opened. */
export interface SiteRow {
  readonly server: HostId;
  readonly baseUrl: string;
  readonly email: string;
  readonly tokenEnc: string;
  readonly cloudId: string | null;
  readonly accountId: string | null;
  readonly displayName: string | null;
  readonly connectedAt: string;
  readonly lastOkAt: string | null;
  readonly lastError: string | null;
}

interface RawSite {
  server: string; base_url: string; email: string; token_enc: string; cloud_id: string | null; account_id: string | null;
  display_name: string | null; connected_at: string; last_ok_at: string | null; last_error: string | null;
}

const COLUMNS = 'server, base_url, email, token_enc, cloud_id, account_id, display_name, connected_at, last_ok_at, last_error';

/** Jira sites are kept per room; a row whose key is no room id is left out and logged. */
function toSite(row: RawSite, log?: Logger): SiteRow | null {
  const server = row.server;
  if (!isRoomId(server)) {
    log?.warn({ table: 'jira_sites', key: server }, 'jira: a site row names no room id and is left out');
    return null;
  }
  return {
    server, baseUrl: row.base_url, email: row.email, tokenEnc: row.token_enc, cloudId: row.cloud_id, accountId: row.account_id,
    displayName: row.display_name, connectedAt: row.connected_at, lastOkAt: row.last_ok_at, lastError: row.last_error,
  };
}

export interface JiraStore {
  sites(): SiteRow[];
  site(server: HostId): SiteRow | null;
  save(row: SiteRow): void;
  remove(server: HostId): void;
  setCloudId(server: HostId, cloudId: string): void;
  /** Records the outcome of a call: ok stamps last_ok_at and clears the error. */
  setHealth(server: HostId, at: string, error: string | null): void;
  seenAt(server: HostId, keys: readonly string[]): ReadonlyMap<string, string>;
  markSeen(server: HostId, key: string, at: string): void;
}

export function createJiraStore(db: Db, log?: Logger): JiraStore {
  const all = db.prepare<[], RawSite>(`SELECT ${COLUMNS} FROM jira_sites ORDER BY server`);
  const one = db.prepare<[string], RawSite>(`SELECT ${COLUMNS} FROM jira_sites WHERE server = ?`);
  const upsert = db.prepare(`INSERT OR REPLACE INTO jira_sites (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const del = db.prepare('DELETE FROM jira_sites WHERE server = ?');
  const delSeen = db.prepare('DELETE FROM jira_seen WHERE server = ?');
  const cloud = db.prepare('UPDATE jira_sites SET cloud_id = ? WHERE server = ?');
  const ok = db.prepare('UPDATE jira_sites SET last_ok_at = ?, last_error = NULL WHERE server = ?');
  const bad = db.prepare('UPDATE jira_sites SET last_error = ? WHERE server = ?');
  const seen = db.prepare<[string], { key: string; seen_at: string }>('SELECT key, seen_at FROM jira_seen WHERE server = ?');
  const mark = db.prepare('INSERT OR REPLACE INTO jira_seen (server, key, seen_at) VALUES (?, ?, ?)');
  const removeAll = db.transaction((server: HostId) => {
    del.run(server);
    delSeen.run(server);
  });

  return {
    sites: () => all.all().flatMap((row) => toSite(row, log) ?? []),
    site(server) {
      const row = one.get(server);
      return row === undefined ? null : toSite(row, log);
    },
    save(row) {
      upsert.run(row.server, row.baseUrl, row.email, row.tokenEnc, row.cloudId, row.accountId, row.displayName, row.connectedAt, row.lastOkAt, row.lastError);
    },
    remove: (server) => removeAll(server),
    setCloudId: (server, cloudId) => cloud.run(cloudId, server),
    setHealth(server, at, error) {
      if (error === null) ok.run(at, server);
      else bad.run(error, server);
    },
    seenAt(server, keys) {
      const wanted = new Set(keys);
      return new Map(seen.all(server).filter((row) => wanted.has(row.key)).map((row) => [row.key, row.seen_at] as const));
    },
    markSeen: (server, key, at) => mark.run(server, key, at),
  };
}
