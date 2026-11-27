import { z } from 'zod';
import { RateWindowDTOSchema, type HostId, type RateWindowDTO } from '@luady/shared';
import type { Db } from '../core/contracts.js';

/** Readings without any limit window, on a host that never reported one, after which its plan counts as not reporting. */
export const NO_LIMITS_AFTER_READINGS = 5;

export type LimitsReported = 'yes' | 'no' | 'unknown';

export interface HostLimits {
  readonly host: HostId;
  /** null = this window never arrived on this host: unknown, never zero. */
  readonly fiveHour: RateWindowDTO | null;
  readonly sevenDay: RateWindowDTO | null;
  readonly reported: LimitsReported;
  readonly updatedAt: string;
  /** When each window last arrived (null = never); hosts of one account are merged window by window. */
  readonly fiveHourAt: string | null;
  readonly sevenDayAt: string | null;
}

export interface LimitsReading { readonly fiveHour: RateWindowDTO | null; readonly sevenDay: RateWindowDTO | null }

export interface LimitsStore {
  /** True when the stored view changed by a whole percent, a reset time or the reported state. */
  record(host: HostId, reading: LimitsReading, atIso: string): boolean;
  get(host: HostId): HostLimits | undefined;
  all(): HostLimits[];
  /**
   * The host moved to another account or signed out: what it reported belonged to the old account and is dropped.
   * Readings older than `atIso` are never taken again.
   */
  reset(host: HostId, atIso: string): void;
}

/** A window as stored: the reading plus when it arrived. */
const StoredWindowSchema = RateWindowDTOSchema.extend({ at: z.string() });
type StoredWindow = z.infer<typeof StoredWindowSchema>;

interface Row {
  host: string; five_hour_json: string | null; seven_day_json: string | null; reported: string; empty_readings: number; updated_at: string;
}
interface Stored { readonly limits: HostLimits; readonly emptyReadings: number }

/** null when its reset time has passed. */
export function liveWindow(window: RateWindowDTO | null, now: Date): RateWindowDTO | null {
  if (window === null) return null;
  return now.getTime() > Date.parse(window.resetsAt) ? null : window;
}

function parseWindow(json: string | null): StoredWindow | null {
  if (json === null) return null;
  try {
    const parsed = StoredWindowSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const toWindow = (stored: StoredWindow | null): RateWindowDTO | null =>
  stored === null ? null : { usedPct: stored.usedPct, resetsAt: stored.resetsAt };
const toJson = (window: RateWindowDTO | null, at: string | null): string | null =>
  window === null || at === null ? null : JSON.stringify({ usedPct: window.usedPct, resetsAt: window.resetsAt, at });
const asReported = (value: string): LimitsReported => (value === 'yes' || value === 'no' ? value : 'unknown');

function fromRow(row: Row): Stored {
  const five = parseWindow(row.five_hour_json);
  const week = parseWindow(row.seven_day_json);
  return {
    limits: {
      host: row.host as HostId, fiveHour: toWindow(five), sevenDay: toWindow(week), reported: asReported(row.reported),
      updatedAt: row.updated_at, fiveHourAt: five?.at ?? null, sevenDayAt: week?.at ?? null,
    },
    emptyReadings: row.empty_readings,
  };
}

function windowMoved(before: RateWindowDTO | null, after: RateWindowDTO | null): boolean {
  if (before === null || after === null) return before !== after;
  return Math.floor(before.usedPct) !== Math.floor(after.usedPct) || before.resetsAt !== after.resetsAt;
}

/** A reading with windows: the windows it has replace the stored ones; a missing one keeps its stored value. */
function withWindows(host: HostId, before: HostLimits | undefined, reading: LimitsReading, atIso: string): HostLimits {
  return {
    host, reported: 'yes', updatedAt: atIso,
    fiveHour: reading.fiveHour ?? before?.fiveHour ?? null,
    fiveHourAt: reading.fiveHour !== null ? atIso : before?.fiveHourAt ?? null,
    sevenDay: reading.sevenDay ?? before?.sevenDay ?? null,
    sevenDayAt: reading.sevenDay !== null ? atIso : before?.sevenDayAt ?? null,
  };
}

export function createLimitsStore(db: Db): LimitsStore {
  const select = db.prepare<[string], Row>('SELECT * FROM account_limits WHERE host = ?');
  const selectAll = db.prepare<[], Row>('SELECT * FROM account_limits ORDER BY host');
  const upsert = db.prepare<[string, string | null, string | null, string, number, string]>(
    `INSERT INTO account_limits (host, five_hour_json, seven_day_json, reported, empty_readings, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(host) DO UPDATE SET five_hour_json = excluded.five_hour_json, seven_day_json = excluded.seven_day_json,
       reported = excluded.reported, empty_readings = excluded.empty_readings, updated_at = excluded.updated_at`,
  );
  const load = (host: HostId): Stored | undefined => {
    const row = select.get(host);
    return row === undefined ? undefined : fromRow(row);
  };
  const save = (limits: HostLimits, emptyReadings: number): void => {
    upsert.run(limits.host, toJson(limits.fiveHour, limits.fiveHourAt), toJson(limits.sevenDay, limits.sevenDayAt), limits.reported, emptyReadings, limits.updatedAt);
  };

  /** No window at all: counts toward "does not report limits" until a window was ever seen. */
  function recordEmpty(host: HostId, before: Stored | undefined, atIso: string): boolean {
    if (before?.limits.reported === 'yes') return false;
    // The same reading replayed (same instant) counts once.
    if (before !== undefined && atIso === before.limits.updatedAt) return false;
    const empty = (before?.emptyReadings ?? 0) + 1;
    const reported: LimitsReported = empty >= NO_LIMITS_AFTER_READINGS ? 'no' : 'unknown';
    save({ host, fiveHour: null, sevenDay: null, fiveHourAt: null, sevenDayAt: null, reported, updatedAt: atIso }, empty);
    return reported !== (before?.limits.reported ?? 'unknown');
  }

  return {
    record(host, reading, atIso) {
      const before = load(host);
      // A replayed spool line is older than what is stored: it never replaces a newer reading.
      if (before !== undefined && atIso < before.limits.updatedAt) return false;
      if (reading.fiveHour === null && reading.sevenDay === null) return recordEmpty(host, before, atIso);
      const next = withWindows(host, before?.limits, reading, atIso);
      save(next, 0);
      const was = before?.limits;
      return was === undefined || was.reported !== 'yes' || windowMoved(was.fiveHour, next.fiveHour) || windowMoved(was.sevenDay, next.sevenDay);
    },
    get: (host) => load(host)?.limits,
    all: () => selectAll.all().map((row) => fromRow(row).limits),
    reset(host, atIso) {
      save({ host, fiveHour: null, sevenDay: null, fiveHourAt: null, sevenDayAt: null, reported: 'unknown', updatedAt: atIso }, 0);
    },
  };
}
