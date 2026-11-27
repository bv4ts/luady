import { formatOffset, localDayBounds, localParts, ownerZone, wallTimeToUtc, zoneOffsetMs } from '@luady/shared';

/**
 * Owner wall-clock arithmetic for the pop-ups and the board's reminders, in the owner's zone (`owner_tz`, read at
 * every call through ownerZone()) and DST-safe: a day is 23 or 25 hours on a change, a wall time in the
 * spring gap moves to the first minute after it, and one in the autumn overlap takes the earlier instant.
 */

const DAY_MS = 86_400_000;

export interface OwnerParts {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekday: number;
}

export const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const);
const MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const);

export function ownerParts(ms: number): OwnerParts {
  const p = localParts(ownerZone(), ms);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, weekday: p.weekday };
}

/**
 * The moment of an owner wall time (month 1–12; days and hours past their range roll over like Date.UTC). A time in a
 * spring-forward gap gives the first minute after it; one in a fall-back overlap the earlier instant.
 */
export function ownerMs(year: number, month: number, day: number, hour = 0, minute = 0): number {
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute));
  return wallTimeToUtc(ownerZone(), {
    year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate(), hour: wall.getUTCHours(), minute: wall.getUTCMinutes(),
  });
}

const two = (n: number): string => String(n).padStart(2, '0');

/** "2026-11-15": the owner calendar day of a moment. */
export function dayKey(ms: number): string {
  const p = ownerParts(ms);
  return `${String(p.year)}-${two(p.month)}-${two(p.day)}`;
}

/** Midnight in owner time at the start of the day that holds `ms`. */
export function startOfOwnerDay(ms: number): number {
  return localDayBounds(ownerZone(), ms).start;
}

/** The start of a `YYYY-MM-DD` owner day; null when it is not a real date. */
export function dayStart(key: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = ownerMs(year, month, day);
  return dayKey(ms) === key ? ms : null;
}

/** "9:00 AM", "12:30 PM": 12-hour clock with a plain space. */
export function clockText(ms: number): string {
  const { hour, minute } = ownerParts(ms);
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(h12)}:${two(minute)} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** Whole calendar days from `now`'s owner day to `ms`'s, counted on the calendar (a 23- or 25-hour day is one day). */
function calendarDays(ms: number, now: number): number {
  const a = ownerParts(ms);
  const b = ownerParts(now);
  return Math.round((Date.UTC(a.year, a.month - 1, a.day) - Date.UTC(b.year, b.month - 1, b.day)) / DAY_MS);
}

/** "Today", "Tomorrow", "Yesterday", a weekday within the coming week ("Thursday"), else "Nov 20" (or "Nov 20, 2027"). */
export function dayWords(ms: number, now: number): string {
  const diff = calendarDays(ms, now);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const p = ownerParts(ms);
  if (diff > 1 && diff < 7) return WEEKDAYS[p.weekday] ?? '';
  const sameYear = p.year === ownerParts(now).year;
  return `${MONTHS[p.month - 1] ?? ''} ${String(p.day)}${sameYear ? '' : `, ${String(p.year)}`}`;
}

/** "Tomorrow, 9:00 AM" — a moment in the owner's words. */
export function whenWords(ms: number, now: number): string {
  return `${dayWords(ms, now)}, ${clockText(ms)}`;
}

/**
 * An ISO time with the owner's offset of that day for a date input (`2026-11-20`) and a time input (`09:00`); null when
 * either is bad. A time in the spring gap becomes the first valid minute after it.
 */
export function isoFromInputs(date: string, time: string): string | null {
  if (!/^\d{2}:\d{2}$/.test(time)) return null;
  const start = dayStart(date);
  const [hour, minute] = [Number(time.slice(0, 2)), Number(time.slice(3, 5))];
  if (start === null || hour > 23 || minute > 59) return null;
  const [year, month, day] = date.split('-').map(Number);
  const at = ownerMs(year ?? 1970, month ?? 1, day ?? 1, hour, minute);
  const p = ownerParts(at);
  return `${dayKey(at)}T${two(p.hour)}:${two(p.minute)}:00${formatOffset(Math.round(zoneOffsetMs(ownerZone(), at) / 60_000))}`;
}

/** The value a date input shows for a moment ("2026-11-20"), in owner time. */
export const dateInput = (ms: number): string => dayKey(ms);

/** The value a time input shows for a moment ("09:00"), in owner time. */
export function timeInput(ms: number): string {
  const p = ownerParts(ms);
  return `${two(p.hour)}:${two(p.minute)}`;
}
