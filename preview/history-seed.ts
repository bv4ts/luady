import { SELF_HOST_ID, type HostId } from '@luady/shared';

/**
 * The fleet wall keeps 24 hours in memory only, so a fresh hub has flat, one-point graphs. Before the hub starts, the
 * preview winds its clock back a day and lets the fleet history take one sample a minute (and the accounts' limits a
 * reading every quarter hour), so the wall shows full graphs at once. The fake fleet's numbers move with the time
 * (fake-fleet.ts `sysinfoAt`).
 */

/** The hub's clock in the preview: real time plus an offset the seed can move. */
export interface PreviewClock {
  now(): Date;
  /** Moves the clock to real time + `offsetMs` (negative = the past). */
  set(offsetMs: number): void;
}

export function createPreviewClock(base: () => number = Date.now): PreviewClock {
  let offset = 0;
  return {
    now: () => new Date(base() + offset),
    set(offsetMs) {
      offset = offsetMs;
    },
  };
}

interface Window { readonly usedPct: number; readonly resetsAt: string }
export interface HistoryHub {
  readonly clock: PreviewClock;
  /** The fleet history's own sample and accounts read (fleet-history/index.ts). */
  sample(): void;
  readAccounts(): Promise<void>;
  /** The limits store's record, as a status line reports it. */
  recordLimits(host: HostId, reading: { fiveHour: Window | null; sevenDay: Window | null }, atIso: string): void;
}

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const LIMIT_HOSTS: readonly HostId[] = ['cedar', 'birch', 'ash', SELF_HOST_ID];
const LIMIT_PHASE: Readonly<Record<string, number>> = { cedar: 0.3, birch: 1.6, ash: 2.8, [SELF_HOST_ID]: 4.1 };

/** A plan's use over the day: the five-hour window climbs and resets, the week creeps up. Deterministic. */
export function limitsAt(host: HostId, at: Date): { fiveHour: Window; sevenDay: Window } {
  const hours = at.getTime() / HOUR_MS;
  const phase = LIMIT_PHASE[host] ?? 0;
  const inWindow = (((hours + phase) % 5) + 5) % 5;
  const five = Math.min(100, Math.round(8 + inWindow * 16 + 6 * Math.sin(hours + phase)));
  const week = Math.min(100, Math.round(35 + 20 * ((((hours / 24 + phase) % 7) + 7) % 7) / 7));
  const resetFive = new Date(at.getTime() + (5 - inWindow) * HOUR_MS).toISOString();
  const resetWeek = new Date(at.getTime() + 3 * 24 * HOUR_MS).toISOString();
  return { fiveHour: { usedPct: five, resetsAt: resetFive }, sevenDay: { usedPct: week, resetsAt: resetWeek } };
}

/** 24 hours of samples, a minute apart, ending now; the clock is back at real time afterwards. */
export async function seedHistory(hub: HistoryHub, hours = 24): Promise<void> {
  try {
    for (let minute = hours * 60; minute >= 0; minute -= 1) {
      hub.clock.set(-minute * MIN_MS);
      hub.sample();
      if (minute % 15 === 0) {
        const at = hub.clock.now();
        for (const host of LIMIT_HOSTS) hub.recordLimits(host, limitsAt(host, at), at.toISOString());
        await hub.readAccounts();
      }
    }
  } finally {
    hub.clock.set(0);
  }
}
