import { LOCAL_HOST_ID, isHostId } from '@luady/shared';
import type { Db, Logger } from '../core/contracts.js';

/**
 * The website's writes to the hosts table (`servers`): SSH drafts, the local row, pin,
 * edit, folders and the tombstone. Every write is limited to `source = 'web'` in its WHERE clause, so a config row is
 * never written here; the config sync, the link status and the versions stay with fleet/servers-repo.ts.
 */
export interface HostRow {
  readonly id: string;
  readonly kind: 'ssh' | 'local';
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly fingerprint: string | null;
  readonly projectsRoot: string | null;
  readonly homeDir: string | null;
  readonly claudeBin: string | null;
  readonly fromAddr: string | null;
  readonly source: 'config' | 'web';
  readonly state: 'draft' | 'pinned' | 'removed';
  readonly kitVersion: string | null;
  readonly claudeVersion: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface DraftInput {
  readonly id: string;
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly projectsRoot: string | null;
  readonly homeDir: string | null;
  readonly claudeBin: string | null;
}

export interface LocalInput {
  readonly user: string;
  readonly projectsRoot: string;
  readonly homeDir: string;
  readonly claudeBin: string | null;
}

export interface RowChanges {
  readonly host?: string;
  readonly user?: string;
  readonly port?: number;
  readonly projectsRoot?: string;
  readonly homeDir?: string;
  readonly claudeBin?: string;
}

export interface HostsRepo {
  /** One row in any state, or undefined (also for an id that does not parse). */
  get(id: string): HostRow | undefined;
  /** Every row but the tombstones, oldest first. */
  list(): HostRow[];
  insertDraft(input: DraftInput, nowIso: string): void;
  /** The local row, pinned: a new one, or this hub's own removed one made again. */
  upsertLocal(input: LocalInput, nowIso: string): void;
  pin(id: string, fingerprint: string, nowIso: string): void;
  /** `toDraft`: an address, user or port change, so the key must be scanned and pinned again. */
  update(id: string, changes: RowChanges, toDraft: boolean, nowIso: string): void;
  /** Fills only folders that are still empty (after a check learned the server's home). */
  fillFolders(id: string, folders: { projectsRoot: string; homeDir: string }, nowIso: string): void;
  tombstone(id: string, nowIso: string): void;
}

interface Row {
  name: string; kind: string; host: string; user: string; port: number; host_key_fp: string | null; projects_root: string | null;
  home_dir: string | null; claude_bin: string | null; from_addr: string | null; source: string; state: string;
  kit_version: string | null; claude_version: string | null; created_at: string | null; updated_at: string | null;
}

const COLUMNS = `name, kind, host, user, port, host_key_fp, projects_root, home_dir, claude_bin, from_addr, source, state, kit_version,
  claude_version, created_at, updated_at`;

function toHostRow(row: Row): HostRow {
  return {
    id: row.name, kind: row.kind === 'local' ? 'local' : 'ssh', host: row.host, user: row.user, port: row.port, fingerprint: row.host_key_fp,
    projectsRoot: row.projects_root, homeDir: row.home_dir, claudeBin: row.claude_bin, fromAddr: row.from_addr,
    source: row.source === 'web' ? 'web' : 'config',
    // An unknown state reads as a draft: never reached until pinned again.
    state: row.state === 'pinned' ? 'pinned' : row.state === 'removed' ? 'removed' : 'draft',
    kitVersion: row.kit_version, claudeVersion: row.claude_version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function statements(db: Db) {
  return {
    get: db.prepare<[string], Row>(`SELECT ${COLUMNS} FROM servers WHERE name = ?`),
    list: db.prepare<[], Row>(`SELECT ${COLUMNS} FROM servers WHERE state <> 'removed' ORDER BY rowid`),
    draft: db.prepare(
      `INSERT INTO servers (name, host, user, host_key_fp, status, kind, port, projects_root, home_dir, claude_bin, from_addr, source, state,
          created_at, updated_at, removed_at)
        VALUES (@id, @host, @user, NULL, 'offline', 'ssh', @port, @projectsRoot, @homeDir, @claudeBin, NULL, 'web', 'draft', @now, @now, NULL)`,
    ),
    local: db.prepare(
      `INSERT INTO servers (name, host, user, host_key_fp, status, kind, port, projects_root, home_dir, claude_bin, from_addr, source, state,
          created_at, updated_at, removed_at)
        VALUES (@id, 'localhost', @user, NULL, 'connecting', 'local', 22, @projectsRoot, @homeDir, @claudeBin, NULL, 'web', 'pinned', @now, @now, NULL)
       ON CONFLICT(name) DO UPDATE SET host = 'localhost', user = excluded.user, host_key_fp = NULL, status = 'connecting', kind = 'local',
          port = 22, projects_root = excluded.projects_root, home_dir = excluded.home_dir, claude_bin = excluded.claude_bin, state = 'pinned',
          updated_at = excluded.updated_at, removed_at = NULL
        WHERE servers.source = 'web' AND servers.state = 'removed'`,
    ),
    pin: db.prepare<[string, string, string]>(
      "UPDATE servers SET host_key_fp = ?, state = 'pinned', status = 'connecting', updated_at = ? WHERE name = ? AND source = 'web' AND state <> 'removed'",
    ),
    update: db.prepare(
      `UPDATE servers SET host = COALESCE(@host, host), user = COALESCE(@user, user), port = COALESCE(@port, port),
          projects_root = COALESCE(@projectsRoot, projects_root), home_dir = COALESCE(@homeDir, home_dir),
          claude_bin = COALESCE(@claudeBin, claude_bin),
          state = CASE WHEN @toDraft = 1 THEN 'draft' ELSE state END,
          host_key_fp = CASE WHEN @toDraft = 1 THEN NULL ELSE host_key_fp END,
          status = CASE WHEN @toDraft = 1 THEN 'offline' ELSE status END, updated_at = @now
        WHERE name = @id AND source = 'web' AND state <> 'removed'`,
    ),
    folders: db.prepare(
      `UPDATE servers SET projects_root = COALESCE(projects_root, @projectsRoot), home_dir = COALESCE(home_dir, @homeDir), updated_at = @now
        WHERE name = @id AND source = 'web' AND state <> 'removed' AND (projects_root IS NULL OR home_dir IS NULL)`,
    ),
    tombstone: db.prepare<[string, string, string]>(
      "UPDATE servers SET state = 'removed', status = 'offline', removed_at = ?, updated_at = ? WHERE name = ? AND source = 'web'",
    ),
  };
}

export function createHostsRepo(db: Db, log?: Logger): HostsRepo {
  const sql = statements(db);
  const parsed = (row: Row | undefined): HostRow | undefined => {
    if (row === undefined) return undefined;
    if (isHostId(row.name)) return toHostRow(row);
    log?.warn({ table: 'servers', key: row.name.slice(0, 64) }, 'hosts: a row with an invalid host id was skipped');
    return undefined;
  };
  return {
    get: (id) => parsed(sql.get.get(id)),
    list: () => sql.list.all().flatMap((row) => parsed(row) ?? []),
    insertDraft: (input, now) => {
      sql.draft.run({ ...input, now });
    },
    upsertLocal: (input, now) => {
      sql.local.run({ ...input, id: LOCAL_HOST_ID, now });
    },
    pin: (id, fingerprint, now) => {
      sql.pin.run(fingerprint, now, id);
    },
    update: (id, changes, toDraft, now) => {
      sql.update.run({
        id, host: changes.host ?? null, user: changes.user ?? null, port: changes.port ?? null, projectsRoot: changes.projectsRoot ?? null,
        homeDir: changes.homeDir ?? null, claudeBin: changes.claudeBin ?? null, toDraft: toDraft ? 1 : 0, now,
      });
    },
    fillFolders: (id, folders, now) => {
      sql.folders.run({ id, ...folders, now });
    },
    tombstone: (id, now) => {
      sql.tombstone.run(now, now, id);
    },
  };
}
