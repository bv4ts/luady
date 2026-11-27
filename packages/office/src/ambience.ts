import { localParts, ownerZone } from '@luady/shared/pure';

/** Day and night in owner time: pure, from the clock and the owner's zone. */

export type AmbiencePhase = 'night' | 'dawn' | 'day' | 'dusk';
export interface Ambience { readonly phase: AmbiencePhase; readonly light: number }

const DAY_MIN = 24 * 60;
/** Dawn runs 5:45–6:45 AM and dusk 5:30–6:45 PM local time, in minutes after midnight, whatever the zone or season. */
export const DAWN = Object.freeze({ from: 5 * 60 + 45, to: 6 * 60 + 45 });
export const DUSK = Object.freeze({ from: 17 * 60 + 30, to: 18 * 60 + 45 });

/** Wall-clock fields of `nowMs` in `tz`; the owner's zone when `tz` is not a zone Intl knows. */
const partsIn = (tz: string, nowMs: number): ReturnType<typeof localParts> => {
  try {
    return localParts(tz, nowMs);
  } catch {
    return localParts(ownerZone(), nowMs);
  }
};

/**
 * Minutes after local midnight in `tz` (default: the owner's zone), with fractions; DST-safe, since it reads the
 * zone's own wall clock. NaN for a time that cannot be read.
 */
export function ownerMinutes(nowMs: number, tz: string = ownerZone()): number {
  if (!Number.isFinite(nowMs)) return Number.NaN;
  const p = partsIn(tz, nowMs);
  const ms = ((nowMs % 1000) + 1000) % 1000;
  const minutes = p.hour * 60 + p.minute + (p.second + ms / 1000) / 60;
  return ((minutes % DAY_MIN) + DAY_MIN) % DAY_MIN;
}

/** Eases 0..1 into 0..1 with a gentle start and end. */
const smooth = (t: number): number => {
  const k = Math.max(0, Math.min(1, t));
  return k * k * (3 - 2 * k);
};

const NIGHT: Ambience = Object.freeze({ phase: 'night', light: 0 });
const DAY: Ambience = Object.freeze({ phase: 'day', light: 1 });

/**
 * The light at `nowMs` in `tz` (default: the owner's zone): 0 is deep night, 1 full day; dawn and dusk are smooth
 * ramps between them at fixed local times. A time that cannot be read counts as night.
 */
export function ambienceAt(nowMs: number, tz: string = ownerZone()): Ambience {
  if (!Number.isFinite(nowMs)) return NIGHT;
  const m = ownerMinutes(nowMs, tz);
  if (m < DAWN.from || m >= DUSK.to) return NIGHT;
  if (m < DAWN.to) return Object.freeze({ phase: 'dawn', light: smooth((m - DAWN.from) / (DAWN.to - DAWN.from)) });
  if (m < DUSK.from) return DAY;
  return Object.freeze({ phase: 'dusk', light: 1 - smooth((m - DUSK.from) / (DUSK.to - DUSK.from)) });
}
