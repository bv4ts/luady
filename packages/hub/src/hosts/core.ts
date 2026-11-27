import type { HostDTO } from '@luady/shared';
import type { ActionKind, ActionService, Clock, Db, EventBus, HubConfig, Logger, PinService, RoomsService } from '../core/contracts.js';
import { NotFoundError } from '../core/errors.js';
import { isoNow } from '../core/time.js';
import type { DynamicFleet } from '../fleet/fleet-core.js';
import type { FleetKey } from '../fleet/fleet-key.js';
import { createServersRepo, type ServersRepo } from '../fleet/servers-repo.js';
import { createChangeFeed, type ChangeFeed } from './changes.js';
import { toHostDto } from './dto.js';
import { HostConflictError } from './errors.js';
import { createGrantStore, type GrantStore } from './grants.js';
import { createKitJobs, type KitJobs } from './kit-job.js';
import { cachedKitPayload, type KitPayload } from './kit-payload.js';
import { createRateLimiter, type RateLimiter } from './limits.js';
import { createHostsRepo, type HostRow, type HostsRepo } from './repo.js';
import { systemLookup, type LookupFn } from './resolve.js';
import { createSshRunner, realLocalKit, realScanner, type HostScanner, type LocalKit, type RemoteRunner } from './runners.js';

/** What the hosts service is built from (wire/hosts.ts). The three outside seams are injectable. */
export interface HostsServiceDeps {
  readonly db: Db;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly log: Logger;
  readonly config: Pick<HubConfig, 'fleetFrom' | 'claudePath'>;
  readonly fleet: DynamicFleet;
  readonly pin: Pick<PinService, 'verify'>;
  readonly fleetKey: FleetKey;
  /** Read at call time (the action service may be created after this one): the audit writer. */
  readonly actions?: () => Pick<ActionService, 'record'> | undefined;
  /** Read at call time: the rooms of a removed host are deleted or kept. */
  readonly rooms?: () => Pick<RoomsService, 'deleteRoomsOfHost'> | undefined;
  /** Whether Claude Code on a host is signed in (claude-login), or null when unknown. */
  readonly signedIn?: (host: string) => boolean | null;
  readonly scanner?: HostScanner;
  readonly remote?: RemoteRunner;
  readonly localKit?: LocalKit;
  readonly lookup?: LookupFn;
  readonly payload?: () => Promise<KitPayload>;
  /** How long `check` waits for the link (up to 20 s). */
  readonly checkWaitMs?: number;
  /** How long the kit's uninstall may take inside a removal before the removal goes on without it (about 30 s). */
  readonly removeUninstallMs?: number;
}

/** A small map replaced on every write (no shared mutable state escapes). */
export interface Memo<V> {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  delete(key: string): void;
}

export function createMemo<V>(): Memo<V> {
  let map: ReadonlyMap<string, V> = new Map();
  return {
    get: (key) => map.get(key),
    set(key, value) {
      map = new Map([...map, [key, value]]);
    },
    delete(key) {
      if (map.has(key)) map = new Map([...map].filter(([name]) => name !== key));
    },
  };
}

export interface ScanMemo {
  readonly fingerprint: string;
  readonly keyType: string;
  readonly at: number;
}

/** Everything the service's parts share. */
export interface Core {
  readonly deps: HostsServiceDeps;
  readonly fleet: DynamicFleet;
  readonly log: Logger;
  readonly repo: HostsRepo;
  readonly versions: Pick<ServersRepo, 'setVersions'>;
  readonly grants: GrantStore;
  readonly jobs: KitJobs;
  readonly limiter: RateLimiter;
  readonly feed: ChangeFeed;
  readonly scanner: HostScanner;
  readonly remote: RemoteRunner;
  readonly localKit: LocalKit;
  readonly lookup: LookupFn;
  readonly payload: () => Promise<KitPayload>;
  readonly scans: Memo<ScanMemo>;
  readonly kitAlias: Memo<string>;
  readonly kitVersion: Memo<string | null>;
  /** Hosts whose folders a check filled in: the fleet rebuilds their link after the next kit job. */
  readonly refresh: Memo<true>;
  /** Hosts with an edit or a removal in flight: a second one is refused (409 `host_busy`). */
  readonly busy: Memo<true>;
  now(): string;
  nowMs(): number;
  /** A row that is not a tombstone: 404 for an unknown id, 409 `host_removed` for a removed one. */
  row(id: string): HostRow;
  dto(row: HostRow): HostDTO;
  list(): HostDTO[];
  audit(kind: ActionKind, host: string, summary: string, result?: string): void;
}

/** Runs one edit or removal of a host at a time; a second caller while one is in flight gets 409 `host_busy`. */
export async function exclusive<T>(core: Core, id: string, run: () => Promise<T>): Promise<T> {
  if (core.busy.get(id) === true) throw new HostConflictError('host_busy', `${id} is being changed right now; try again in a moment`);
  core.busy.set(id, true);
  try {
    return await run();
  } finally {
    core.busy.delete(id);
  }
}

export function createCore(deps: HostsServiceDeps): Core {
  const repo = createHostsRepo(deps.db, deps.log);
  const kitAlias = createMemo<string>();
  const kitVersion = createMemo<string | null>();
  const dto = (row: HostRow): HostDTO => toHostDto(row, {
    link: (id) => deps.fleet.link(id),
    lastError: (id) => deps.fleet.executor(id)?.lastError?.() ?? null,
    kitAlias: (id) => kitAlias.get(id) ?? null,
    kitVersion: (id) => kitVersion.get(id),
    claudeSignedIn: (id) => deps.signedIn?.(id) ?? null,
  });
  const list = (): HostDTO[] => repo.list().map(dto);
  return {
    deps, fleet: deps.fleet, log: deps.log, repo, versions: createServersRepo(deps.db, deps.log),
    grants: createGrantStore({ clock: deps.clock }), jobs: createKitJobs({ bus: deps.bus, clock: deps.clock, log: deps.log }),
    limiter: createRateLimiter(deps.clock), feed: createChangeFeed({ bus: deps.bus, clock: deps.clock, list }),
    scanner: deps.scanner ?? realScanner, remote: deps.remote ?? createSshRunner({ fleet: deps.fleet, log: deps.log }),
    localKit: deps.localKit ?? realLocalKit, lookup: deps.lookup ?? systemLookup, payload: deps.payload ?? cachedKitPayload(),
    scans: createMemo(), kitAlias, kitVersion, refresh: createMemo(), busy: createMemo(),
    now: () => isoNow(deps.clock),
    nowMs: () => deps.clock.now().getTime(),
    row(id) {
      const row = repo.get(id);
      if (row === undefined) throw new NotFoundError(`Unknown host ${id}`);
      if (row.state === 'removed') throw new HostConflictError('host_removed', `${id} was removed`);
      return row;
    },
    dto,
    list,
    audit(kind, host, summary, result = 'done') {
      try {
        deps.actions?.()?.record?.({ kind, actor: 'owner', channel: 'web', params: { host }, summary, result });
      } catch (err) {
        deps.log.error({ host, kind, err: err instanceof Error ? err.message : String(err) }, 'hosts: the audit row was not written');
      }
    },
  };
}
