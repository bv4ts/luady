import { localParts, ownerFormat, ownerZone } from '@luady/shared';
import { parseTime } from '../../../../lib/format.js';

/** Times on the board and in notes are owner times in 12-hour form ("3:20 PM"), in the owner's zone. */
const CLOCK = ownerFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
const DAY = ownerFormat('en-US', { month: 'short', day: 'numeric' });
const DAY_MS = 86_400_000;

/** Newer ICU puts a narrow no-break space before AM/PM; the owner reads a plain space. */
const plain = (text: string): string => text.replace(/[  ]/g, ' ');

/** The owner's calendar day of an instant as a day count (DST-safe: a 23- or 25-hour day is still one day). */
function ownerDayNumber(ms: number): number {
  const p = localParts(ownerZone(), ms);
  return Math.round(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS);
}

/** How many of the owner's calendar days lie between two instants: 0 the same day, 1 when `at` was yesterday. */
export function ownerDaysBetween(now: number, at: number): number {
  return ownerDayNumber(now) - ownerDayNumber(at);
}

/** "3:20 PM", or null for a missing or broken time. */
export function clockTime(iso: string | null | undefined): string | null {
  const time = parseTime(iso);
  return time === null ? null : plain(CLOCK.format(time));
}

/** "3:20 PM" today, "Yesterday, 3:20 PM", else "Nov 14, 3:20 PM" (all in owner time); "" when there is no time. */
export function whenText(iso: string | null | undefined, now: number = Date.now()): string {
  const time = parseTime(iso);
  if (time === null) return '';
  const clock = plain(CLOCK.format(time));
  const days = ownerDaysBetween(now, time);
  if (days === 0) return clock;
  if (days === 1) return `Yesterday, ${clock}`;
  return `${DAY.format(time)}, ${clock}`;
}
