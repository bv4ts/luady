import { LIMITS, type AccountDTO, type CtlSysinfo, type FleetHistoryDTO, type HostId } from '@luady/shared';
import type { AccountsService } from '../accounts/service.js';
import type { Clock, EventBus, FleetHistoryService, Fleet, Logger } from '../core/contracts.js';

/** Everything the fleet wall needs (wired in app.ts). */
export interface FleetHistoryDeps {
  /** `accounts.changed` and `meters.updated` say when limits moved. */
  bus: EventBus;
  clock: Clock;
  log: Logger;
  /** Each server's load, memory and disk as the hub already holds them (`servers()`). */
  fleet: Pick<Fleet, 'servers'>;
  /** Each account and its two limits. */
  accounts: Pick<AccountsService, 'list'>;
}

export const FLEET_SAMPLE_MS = 60_000;
/** Limits move with every status line; the accounts are read again at most this often. */
export const ACCOUNTS_READ_MIN_MS = 30_000;
const HOUR_MS = 60 * 60_000;

type ServerPoint = [number, number, number, number | null];
type AccountPoint = [number, number | null, number | null];

const round1 = (value: number): number => Math.round(value * 10) / 10;
const pct = (value: number): number => Math.max(0, Math.min(100, round1(value)));

/** Memory in use, in percent; null without a total. */
export function memPct(info: CtlSysinfo): number | null {
  return info.mem_total_kb > 0 ? pct(100 * (1 - info.mem_avail_kb / info.mem_total_kb)) : null;
}

/** Disk in use, in percent, when the kit reports the disk's size (kit 2.1.0); null otherwise, never a guess. */
export function diskPct(info: CtlSysinfo): number | null {
  const total = info.disk_total_kb;
  if (total === undefined || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(((total - info.disk_free_kb) / total) * 100)));
}

/** At most `max` points, spread evenly over the series, always keeping the first and the last. */
export function thin<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return [...points];
  if (max <= 1) return points.slice(-1);
  return Array.from({ length: max }, (_, i) => points[Math.round((i * (points.length - 1)) / (max - 1))]!);
}

function accountLabel(account: AccountDTO): string {
  if (account.provider === 'codex') return 'ChatGPT (Codex)';
  return account.email ?? account.orgName ?? (account.hosts.map((host) => host.host).join(', ') || account.id);
}

/** The fleet wall: 24 hours of every server and every account, in memory only. */
export function createFleetHistoryService(deps: FleetHistoryDeps): FleetHistoryService & { sample(): void; readAccounts(): Promise<void> } {
  let servers = new Map<HostId, readonly ServerPoint[]>();
  let accounts = new Map<string, { label: string; points: readonly AccountPoint[] }>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let offs: Array<() => void> = [];
  let lastRead = 0;
  let reading: Promise<void> | null = null;
  /** A change arrived while a read was not allowed: the next minute's sample reads again. */
  let missed = false;

  const nowMs = (): number => deps.clock.now().getTime();
  const cutoff = (): number => Math.floor((nowMs() - LIMITS.fleetHistoryHours * HOUR_MS) / 1000);
  const keep = <T extends readonly [number, ...unknown[]]>(points: readonly T[]): T[] => points.filter((point) => point[0] >= cutoff());

  /** One point per online server; an offline server gets none (its graph shows the gap). */
  function sample(): void {
    const t = Math.floor(nowMs() / 1000);
    const next = new Map<HostId, readonly ServerPoint[]>();
    for (const server of deps.fleet.servers()) {
      const previous = keep(servers.get(server.name) ?? []);
      const info = server.sysinfo;
      const mem = info === null ? null : memPct(info);
      const point: ServerPoint | null = server.status !== 'online' || info === null || mem === null
        ? null
        : [t, Math.max(0, round1(info.load1)), mem, diskPct(info)];
      next.set(server.name, point === null ? previous : [...previous, point]);
    }
    servers = next;
  }

  /** A point for each account whose limits changed since its last point. */
  async function readAccounts(): Promise<void> {
    const t = Math.floor(nowMs() / 1000);
    const list = (await deps.accounts.list()).accounts;
    const next = new Map<string, { label: string; points: readonly AccountPoint[] }>();
    for (const account of list) {
      const previous = keep(accounts.get(account.id)?.points ?? []);
      const point: AccountPoint = [t, account.limits.fiveHour?.usedPct ?? null, account.limits.sevenDay?.usedPct ?? null];
      const last = previous.at(-1);
      const same = last !== undefined && last[1] === point[1] && last[2] === point[2];
      const reported = point[1] !== null || point[2] !== null;
      next.set(account.id, { label: accountLabel(account), points: same || (!reported && last === undefined) ? previous : [...previous, point] });
    }
    accounts = next;
  }

  /** Limits change often (every status line); one read at a time, at most every 30 seconds. */
  function onLimitsMoved(): void {
    if (reading !== null || nowMs() - lastRead < ACCOUNTS_READ_MIN_MS) {
      missed = true;
      return;
    }
    missed = false;
    lastRead = nowMs();
    reading = readAccounts()
      .catch((err: unknown) => deps.log.warn({ err }, 'fleet-history: accounts not read'))
      .finally(() => {
        reading = null;
      });
  }

  return {
    history(): FleetHistoryDTO {
      return {
        servers: [...servers.entries()].map(([name, points]) => ({ name, points: thin(keep(points), LIMITS.fleetPointsMax) })),
        accounts: [...accounts.entries()].map(([id, account]) => ({
          id, label: account.label, points: thin(keep(account.points), LIMITS.fleetPointsMax),
        })),
      };
    },
    start() {
      if (timer !== null) return;
      sample();
      onLimitsMoved();
      timer = setInterval(() => {
        try {
          sample();
          if (missed) onLimitsMoved();
        } catch (err) {
          deps.log.warn({ err }, 'fleet-history: sample failed');
        }
      }, FLEET_SAMPLE_MS);
      offs = [deps.bus.on('accounts.changed', onLimitsMoved), deps.bus.on('meters.updated', onLimitsMoved)];
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
      for (const off of offs) off();
      offs = [];
    },
    sample,
    readAccounts,
  };
}
