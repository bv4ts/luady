import { ownerFormat, type Settings } from '@luady/shared';
import type { Clock } from './contracts.js';
import { ValidationError } from './errors.js';

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

// The owner's zone (read at call time) + h23: never depends on the host's TZ, and midnight is "00", not "24".
const OWNER_FORMAT = ownerFormat('en-US', {
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}

export function ownerParts(d: Date): { hhmm: string; weekday: string; minutes: number } {
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError('ownerParts needs a valid Date');
  }
  const parts = OWNER_FORMAT.formatToParts(d);
  const pick = (type: Intl.DateTimeFormatPartTypes): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) {
      throw new Error(`Intl.DateTimeFormat returned no ${type} part`);
    }
    return value;
  };
  const hour = pick('hour');
  const minute = pick('minute');
  return {
    hhmm: `${hour}:${minute}`,
    weekday: pick('weekday'),
    minutes: Number(hour) * MINUTES_PER_HOUR + Number(minute),
  };
}

/** Owner-facing owner time in 12-hour form, e.g. "3:05 PM" (the owner prefers AM/PM over 24-hour). */
export function clock12(d: Date): string {
  const { minutes } = ownerParts(d);
  const hour = Math.floor(minutes / MINUTES_PER_HOUR);
  const minute = String(minutes % MINUTES_PER_HOUR).padStart(2, '0');
  return `${hour % 12 === 0 ? 12 : hour % 12}:${minute} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** Start is inclusive, end exclusive; a window may cross midnight; start == end means "never quiet". */
export function inQuietHours(d: Date, q: Settings['quiet_hours']): boolean {
  const start = hhmmToMinutes(q.start);
  const end = hhmmToMinutes(q.end);
  if (start === end) {
    return false;
  }
  const now = ownerParts(d).minutes;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function injectionStamp(d: Date): string {
  const { weekday, hhmm } = ownerParts(d);
  return `${weekday} ${hhmm}`;
}

export function humanDuration(sec: number): string {
  const total = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  if (total < SECONDS_PER_MINUTE) {
    return `${total}s`;
  }
  if (total < SECONDS_PER_HOUR) {
    return `${Math.floor(total / SECONDS_PER_MINUTE)}m`;
  }
  const hours = Math.floor(total / SECONDS_PER_HOUR);
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  return `${hours}h${String(minutes).padStart(2, '0')}m`;
}

function hhmmToMinutes(hhmm: string): number {
  const match = HHMM_RE.exec(hhmm);
  if (match === null) {
    throw new ValidationError(`Quiet hours need HH:MM, got "${hhmm}"`);
  }
  return Number(match[1]) * MINUTES_PER_HOUR + Number(match[2]);
}
