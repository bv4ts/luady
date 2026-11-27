import { KIT_V21, LIMITS, versionAtLeast, type HostId } from '@luady/shared';
import { PER_HOST_CONCURRENCY, forEachLimit } from '../core/concurrency.js';
import type { Clock, EventBus, Fleet, Logger } from '../core/contracts.js';
import { isoNow } from '../core/time.js';
import { buildKbFiles, type OfficeNameOf } from './files.js';
import type { KbRow, KbStore } from './store.js';

/**
 * The copy of the pages on every server, through the kit verb `kb-put` with `prune`. 30 seconds after a
 * change, when a server comes online, and on "Sync now". Skipped when nothing changed for that server (digest), when
 * the server is offline, and when its kit is older than 2.1.0. Never to the self host (it is not a server).
 */

export const KB_SYNC_DELAY_MS = 30_000;

export type SyncOutcome = 'sent' | 'unchanged' | 'offline' | 'old-kit';

export interface KbSyncDeps {
  readonly store: KbStore;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly log: Logger;
  readonly fleet: Fleet;
  /** After a copy reached a server (the website shows when). */
  readonly onSynced: () => void;
  /** The office name INDEX.md uses for a host (its home room's name). */
  readonly officeName?: OfficeNameOf;
}

export interface KbSync {
  /** A page changed: copy everywhere in 30 seconds (one copy for a burst of changes). */
  schedule(): void;
  /** `force` skips the digest check (Sync now). Rejects only when `kb-put` itself failed. */
  syncServer(server: HostId, force: boolean): Promise<SyncOutcome>;
  /** Every server; failures are logged, never thrown. */
  syncAll(force: boolean): Promise<void>;
  syncedAt(): Partial<Record<HostId, string | null>>;
  start(): void;
  stop(): void;
}

export function createKbSync(deps: KbSyncDeps): KbSync {
  /** A host with a kit the fleet has: an SSH server or this computer; never the self host. */
  const isServer = (name: string): boolean => deps.fleet.hasServer(name) || deps.fleet.hasLocal(name);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let off: (() => void) | null = null;
  const running = new Map<HostId, Promise<SyncOutcome>>();
  /** Per server: its link state and kit version when last seen. */
  const lastSeen = new Map<HostId, string>();

  async function copy(server: HostId, force: boolean): Promise<SyncOutcome> {
    const dto = deps.fleet.servers().find((s) => s.name === server);
    if (dto === undefined || dto.status !== 'online') return 'offline';
    if (!versionAtLeast(dto.kitVersion, KIT_V21)) {
      deps.log.debug({ server, kit: dto.kitVersion }, 'kb: kit too old for kb-put, skipped');
      return 'old-kit';
    }
    const pages: readonly KbRow[] = deps.store.all();
    const set = buildKbFiles(pages, server, LIMITS.kbSyncMaxBytes, deps.officeName);
    if (!force && deps.store.synced().get(server)?.digest === set.digest) return 'unchanged';
    const result = await deps.fleet.client(server).kbPut(set.files, true);
    deps.store.setSynced(server, isoNow(deps.clock), set.digest);
    deps.log.info({ server, written: result.written, removed: result.removed, dropped: set.dropped.length }, 'kb: copied to server');
    deps.onSynced();
    return 'sent';
  }

  /** One copy per server at a time; a second request waits for the first. */
  function syncServer(server: HostId, force: boolean): Promise<SyncOutcome> {
    if (!isServer(server)) return Promise.resolve('offline');
    const before = running.get(server) ?? Promise.resolve<SyncOutcome>('unchanged');
    const next = before.catch(() => 'unchanged' as const).then(() => copy(server, force));
    running.set(server, next);
    return next.finally(() => {
      if (running.get(server) === next) running.delete(server);
    });
  }

  /** Every host, at most PER_HOST_CONCURRENCY copies at once. */
  async function syncAll(force: boolean): Promise<void> {
    await forEachLimit(deps.fleet.servers().map((s) => s.name), PER_HOST_CONCURRENCY, (server) => syncServer(server, force), (server, err) => {
      deps.log.warn({ server, err: err instanceof Error ? err.message : String(err) }, 'kb: copy to server failed');
    });
  }

  /** A server that comes online gets its copy, and so does an online one whose kit changed (an upgrade to 2.1 makes the copy possible). */
  function onServer(server: { name: string; status: string; kitVersion?: string | null }): void {
    if (!isServer(server.name)) return;
    const seen = `${server.status}|${server.kitVersion ?? ''}`;
    const previous = lastSeen.get(server.name);
    lastSeen.set(server.name, seen);
    if (server.status === 'online' && previous !== seen) {
      syncServer(server.name, false).catch((err: unknown) => {
        deps.log.warn({ server: server.name, err: err instanceof Error ? err.message : String(err) }, 'kb: copy on reconnect failed');
      });
    }
  }

  return {
    schedule() {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void syncAll(false);
      }, KB_SYNC_DELAY_MS);
      timer.unref?.();
    },
    syncServer,
    syncAll,
    syncedAt() {
      const synced = deps.store.synced();
      return Object.fromEntries(deps.fleet.servers().map((s) => [s.name, synced.get(s.name)?.at ?? null]));
    },
    start() {
      if (off !== null) return;
      off = deps.bus.on('server.updated', onServer);
      for (const server of deps.fleet.servers()) onServer(server);
    },
    stop() {
      off?.();
      off = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
