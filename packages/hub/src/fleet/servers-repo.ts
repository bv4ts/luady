import { CtlSysinfoSchema, LOCAL_HOST_ID, isHostId, type CtlSysinfo, type ServerDTO } from '@luady/shared';
import type { Db, HubConfig, Logger } from '../core/contracts.js';
import type { LinkStatus } from './executor.js';

/** The hosts table (`servers`, extended by 016). */
interface ServerRow {
  name: string;
  host: string;
  user: string;
  host_key_fp: string | null;
  status: string;
  last_seen_at: string | null;
  sysinfo_json: string | null;
  kit_version: string | null;
  claude_version: string | null;
  kind: string;
  port: number;
  projects_root: string | null;
  home_dir: string | null;
  claude_bin: string | null;
  from_addr: string | null;
  source: string;
  state: string;
}

/** What the fleet builds an executor from: one pinned row. */
export interface HostRecord {
  readonly id: string;
  readonly kind: 'ssh' | 'local';
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly hostKeyFp: string | null;
  readonly projectsRoot: string | null;
  readonly homeDir: string | null;
  readonly claudeBin: string | null;
  readonly fromAddr: string | null;
  readonly source: 'config' | 'web';
  readonly state: 'draft' | 'pinned' | 'removed';
}

/** What one config sync did. */
export interface ConfigSyncResult {
  /** Config rows written (upserted) this start. */
  readonly upserted: readonly string[];
  /** File entries skipped because a website-made host already has the id (a `doctor` FAIL). */
  readonly collisions: readonly string[];
  /** Config rows that left the file and are now `removed`. */
  readonly removed: readonly string[];
}

const STATUSES: readonly LinkStatus[] = ['online', 'offline', 'connecting'];
const COLUMNS = `name, host, user, host_key_fp, status, last_seen_at, sysinfo_json, kit_version, claude_version, kind, port,
  projects_root, home_dir, claude_bin, from_addr, source, state`;

export interface ServersRepo {
  /** Upserts `source = 'config'` rows from `servers[]` and `localHost`, and marks config rows that left the file `removed`. */
  syncConfig(config: Pick<HubConfig, 'servers' | 'localHost'>, owner: { user: string; nowIso: string }): ConfigSyncResult;
  /** Every pinned row, oldest first: the hosts the fleet builds executors for. */
  pinned(): HostRecord[];
  /** One row in any state; undefined when there is none or its id does not parse. */
  record(id: string): HostRecord | undefined;
  setStatus(name: string, status: LinkStatus, nowIso: string): void;
  setVersions(name: string, kit: string, claude: string | null): void;
  setSysinfo(name: string, sysinfo: CtlSysinfo, nowIso: string): void;
  get(name: string): ServerDTO | undefined;
  /** The rows of these ids in their order, read with one query (no query per host); missing ids are skipped. */
  list(ids: readonly string[]): ServerDTO[];
}

function parseSysinfo(json: string | null): CtlSysinfo | null {
  if (json === null) return null;
  try {
    const parsed = CtlSysinfoSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toServerDto(row: ServerRow): ServerDTO {
  return {
    name: row.name,
    host: row.host,
    status: STATUSES.find((status) => status === row.status) ?? 'offline',
    lastSeenAt: row.last_seen_at,
    claudeVersion: row.claude_version,
    kitVersion: row.kit_version,
    sysinfo: parseSysinfo(row.sysinfo_json),
    // The web terminal is for SSH servers only.
    kind: row.kind === 'local' ? 'local' : 'ssh',
    projectsRoot: row.projects_root,
    homeDir: row.home_dir,
    terminal: row.kind !== 'local',
  };
}

function toRecord(row: ServerRow): HostRecord {
  return {
    id: row.name,
    kind: row.kind === 'local' ? 'local' : 'ssh',
    host: row.host,
    user: row.user,
    port: row.port,
    hostKeyFp: row.host_key_fp,
    projectsRoot: row.projects_root,
    homeDir: row.home_dir,
    claudeBin: row.claude_bin,
    fromAddr: row.from_addr,
    source: row.source === 'web' ? 'web' : 'config',
    // An unknown state (a row written by hand or by a later version) is a draft: never reached until pinned again.
    state: row.state === 'pinned' ? 'pinned' : row.state === 'removed' ? 'removed' : 'draft',
  };
}

interface ConfigRow {
  readonly name: string;
  readonly kind: 'ssh' | 'local';
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly hostKeyFp: string | null;
  readonly projectsRoot: string | null;
  readonly homeDir: string | null;
  readonly claudeBin: string | null;
  readonly fromAddr: string | null;
}

/** The rows the config file asks for: each `servers[]` entry, and the local host when `localHost` is set. */
function configRows(config: Pick<HubConfig, 'servers' | 'localHost'>, user: string): ConfigRow[] {
  const servers = config.servers.map((server): ConfigRow => ({
    name: server.name, kind: 'ssh', host: server.host, user: server.user, port: server.port, hostKeyFp: server.hostKeyFp,
    projectsRoot: server.projectsRoot ?? null, homeDir: server.homeDir ?? null, claudeBin: server.claudeBin ?? null,
    fromAddr: server.fromAddr ?? null,
  }));
  const local = config.localHost;
  if (local === undefined) return servers;
  return [...servers, {
    name: LOCAL_HOST_ID, kind: 'local', host: 'localhost', user, port: 22, hostKeyFp: null, projectsRoot: local.projectsRoot,
    homeDir: null, claudeBin: local.claudeBin ?? null, fromAddr: null,
  }];
}

function statements(db: Db) {
  return {
    upsert: db.prepare(
      `INSERT INTO servers (name, host, user, host_key_fp, status, kind, port, projects_root, home_dir, claude_bin, from_addr, source, state,
          created_at, updated_at, removed_at)
        VALUES (@name, @host, @user, @hostKeyFp, 'connecting', @kind, @port, @projectsRoot, @homeDir, @claudeBin, @fromAddr, 'config', 'pinned',
          @now, @now, NULL)
       ON CONFLICT(name) DO UPDATE SET host = excluded.host, user = excluded.user, host_key_fp = excluded.host_key_fp, status = 'connecting',
          kind = excluded.kind, port = excluded.port, projects_root = excluded.projects_root, home_dir = excluded.home_dir,
          claude_bin = excluded.claude_bin, from_addr = excluded.from_addr, source = 'config', state = 'pinned',
          created_at = COALESCE(servers.created_at, excluded.created_at), updated_at = excluded.updated_at, removed_at = NULL`,
    ),
    sourceOf: db.prepare<[string], { source: string }>('SELECT source FROM servers WHERE name = ?'),
    liveConfig: db.prepare<[], { name: string }>("SELECT name FROM servers WHERE source = 'config' AND state <> 'removed'"),
    markRemoved: db.prepare<[string, string, string]>("UPDATE servers SET state = 'removed', removed_at = ?, updated_at = ? WHERE name = ?"),
    status: db.prepare(
      `UPDATE servers SET status = @status, last_seen_at = CASE WHEN @status = 'online' THEN @now ELSE last_seen_at END WHERE name = @name`,
    ),
    versions: db.prepare('UPDATE servers SET kit_version = @kit, claude_version = @claude WHERE name = @name'),
    sysinfo: db.prepare('UPDATE servers SET sysinfo_json = @json, last_seen_at = @now WHERE name = @name'),
    select: db.prepare<[string], ServerRow>(`SELECT ${COLUMNS} FROM servers WHERE name = ?`),
    pinned: db.prepare<[], ServerRow>(`SELECT ${COLUMNS} FROM servers WHERE state = 'pinned' ORDER BY rowid`),
    all: db.prepare<[], ServerRow>(`SELECT ${COLUMNS} FROM servers`),
  };
}

export function createServersRepo(db: Db, log?: Logger): ServersRepo {
  const sql = statements(db);
  /** A row whose id does not parse is logged, never read. */
  const parsed = (row: ServerRow | undefined): ServerRow | undefined => {
    if (row === undefined) return undefined;
    if (isHostId(row.name)) return row;
    log?.warn({ table: 'servers', key: row.name.slice(0, 64) }, 'servers: a row with an invalid host id was skipped');
    return undefined;
  };

  const sync = db.transaction((rows: readonly ConfigRow[], nowIso: string): ConfigSyncResult => {
    const collisions = rows.filter((row) => sql.sourceOf.get(row.name)?.source === 'web').map((row) => row.name);
    const writable = rows.filter((row) => !collisions.includes(row.name));
    for (const row of writable) sql.upsert.run({ ...row, now: nowIso });
    const wanted = new Set(rows.map((row) => row.name));
    const removed = sql.liveConfig.all().map((row) => row.name).filter((name) => !wanted.has(name));
    for (const name of removed) sql.markRemoved.run(nowIso, nowIso, name);
    return { upserted: writable.map((row) => row.name), collisions, removed };
  });

  return {
    syncConfig: (config, owner) => sync(configRows(config, owner.user), owner.nowIso),
    pinned: () => sql.pinned.all().flatMap((row) => parsed(row) ?? []).map(toRecord),
    record: (id) => {
      const row = parsed(sql.select.get(id));
      return row === undefined ? undefined : toRecord(row);
    },
    setStatus: (name, next, nowIso) => {
      sql.status.run({ name, status: next, now: nowIso });
    },
    setVersions: (name, kit, claude) => {
      sql.versions.run({ name, kit, claude });
    },
    setSysinfo: (name, info, nowIso) => {
      sql.sysinfo.run({ name, json: JSON.stringify(info), now: nowIso });
    },
    get: (name) => {
      const row = parsed(sql.select.get(name));
      return row === undefined ? undefined : toServerDto(row);
    },
    list: (ids) => {
      if (ids.length === 0) return [];
      const byName = new Map(sql.all.all().map((row) => [row.name, row]));
      return ids.flatMap((id) => {
        const row = parsed(byName.get(id));
        return row === undefined ? [] : [toServerDto(row)];
      });
    },
  };
}
