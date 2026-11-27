/**
 * The owner's time zone and DST-safe wall-time maths. Pure: Intl only, no imports.
 *
 * The zone is the `owner_tz` setting. The hub sets it at boot and on every settings change (UTC while none is set); the
 * website when the settings load (this browser's own zone while none is set). Every formatter that shows the owner a
 * time reads it at call time through ownerZone().
 */

const DEFAULT_ZONE = 'UTC';
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

let zone = DEFAULT_ZONE;

/** True when Intl knows the zone. */
export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The owner's IANA zone right now (UTC until it is set). */
export function ownerZone(): string {
  return zone;
}

/** Sets the owner's zone. An unknown zone is refused and the current one kept: returns whether it was applied. */
export function setOwnerZone(tz: string): boolean {
  if (!isTimeZone(tz)) return false;
  zone = tz;
  return true;
}

/** The wall-clock fields of an instant in a zone; month 1-12, weekday 0 (Sunday) to 6. */
export interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly weekday: number;
}

/** A wall time to place in a zone; seconds default to 0. */
export interface WallTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second?: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  const cached = partsFormatters.get(tz);
  if (cached !== undefined) return cached;
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  partsFormatters.set(tz, made);
  return made;
}

export function localParts(tz: string, ms: number): LocalParts {
  const fields: Record<string, string> = {};
  for (const part of partsFormatter(tz).formatToParts(new Date(ms))) fields[part.type] = part.value;
  const num = (key: string): number => Number(fields[key] ?? '0');
  return {
    year: num('year'), month: num('month'), day: num('day'), hour: num('hour') % 24, minute: num('minute'), second: num('second'),
    weekday: WEEKDAYS[fields.weekday ?? 'Sun'] ?? 0,
  };
}

/** The zone's offset from UTC at an instant, in ms (local minus UTC): -5 h for America/New_York in January. */
export function zoneOffsetMs(tz: string, atMs: number): number {
  const whole = Math.floor(atMs / 1000) * 1000;
  const p = localParts(tz, whole);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

const wallMs = (w: WallTime): number => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second ?? 0);

/**
 * The instant a wall time names in a zone. In an overlap (clocks go back) the earlier instant wins; in a gap (clocks
 * go forward) the first valid minute after the gap.
 */
export function wallTimeToUtc(tz: string, wall: WallTime): number {
  const naive = wallMs(wall);
  const before = naive - zoneOffsetMs(tz, naive - DAY_MS);
  const after = naive - zoneOffsetMs(tz, naive + DAY_MS);
  const fits = (t: number): boolean => t + zoneOffsetMs(tz, t) === naive;
  const valid = [before, after].filter(fits);
  if (valid.length > 0) return Math.min(...valid);
  // A gap: the transition lies between the two candidates; find its first minute.
  let lo = Math.min(before, after);
  let hi = Math.max(before, after);
  const loOffset = zoneOffsetMs(tz, lo);
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
    if (zoneOffsetMs(tz, mid) === loOffset) lo = mid;
    else hi = mid;
  }
  return hi;
}

/** The UTC bounds of the zone's calendar day holding `ms`: 23 or 25 hours long on a DST change. */
export function localDayBounds(tz: string, ms: number): { readonly start: number; readonly end: number } {
  const p = localParts(tz, ms);
  const start = wallTimeToUtc(tz, { year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 });
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const end = wallTimeToUtc(tz, { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0 });
  return { start, end };
}

/** "+02:00", "-05:00", "+00:00" for an offset in minutes. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(Math.round(minutes));
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

/** A date formatter in the owner's zone, read at every call; one Intl formatter is kept per zone. */
export interface OwnerFormat {
  format(at: Date | number): string;
  formatToParts(at: Date | number): Intl.DateTimeFormatPart[];
}

export function ownerFormat(locale: string, options: Intl.DateTimeFormatOptions): OwnerFormat {
  const byZone = new Map<string, Intl.DateTimeFormat>();
  const current = (): Intl.DateTimeFormat => {
    const tz = ownerZone();
    const cached = byZone.get(tz);
    if (cached !== undefined) return cached;
    const made = new Intl.DateTimeFormat(locale, { ...options, timeZone: tz });
    byZone.set(tz, made);
    return made;
  };
  return {
    format: (at) => current().format(at),
    formatToParts: (at) => current().formatToParts(at),
  };
}
