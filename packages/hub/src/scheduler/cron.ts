import { wallTimeToUtc, zoneOffsetMs } from '@luady/shared';
import { ValidationError } from '../core/errors.js';

export interface CronSpec {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

interface FieldRange {
  name: string;
  min: number;
  max: number;
}

const MINUTE_FIELD: FieldRange = { name: 'minute', min: 0, max: 59 };
const HOUR_FIELD: FieldRange = { name: 'hour', min: 0, max: 23 };
const DAY_FIELD: FieldRange = { name: 'day of month', min: 1, max: 31 };
const MONTH_FIELD: FieldRange = { name: 'month', min: 1, max: 12 };
const WEEKDAY_FIELD: FieldRange = { name: 'day of week', min: 0, max: 7 };
const PART_RE = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/;
const MINUTE_MS = 60_000;
const SEARCH_LIMIT_MS = 5 * 366 * 24 * 60 * MINUTE_MS;

function bounds(base: string, field: FieldRange, stepped: boolean): [number, number] {
  if (base === '*') return [field.min, field.max];
  const [startText, endText] = base.split('-');
  const start = Number(startText);
  if (endText !== undefined) return [start, Number(endText)];
  return [start, stepped ? field.max : start];
}

function parsePart(part: string, field: FieldRange): number[] {
  const match = PART_RE.exec(part);
  const base = match?.[1];
  if (!match || base === undefined) throw new ValidationError(`Invalid ${field.name} "${part}"`);
  const step = match[2] === undefined ? 1 : Number(match[2]);
  const [start, end] = bounds(base, field, match[2] !== undefined);
  if (step < 1 || start < field.min || end > field.max || start > end) {
    throw new ValidationError(`Invalid ${field.name} "${part}"`);
  }
  const values: number[] = [];
  for (let value = start; value <= end; value += step) values.push(value);
  return values;
}

function parseField(text: string, field: FieldRange): Set<number> {
  return new Set(text.split(',').flatMap((part) => parsePart(part, field)));
}

export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new ValidationError('A cron expression needs 5 fields: minute hour day month weekday');
  const [minute = '', hour = '', day = '', month = '', weekday = ''] = fields;
  const weekdays = [...parseField(weekday, WEEKDAY_FIELD)].map((d) => (d === 7 ? 0 : d));
  return {
    minutes: parseField(minute, MINUTE_FIELD),
    hours: parseField(hour, HOUR_FIELD),
    days: parseField(day, DAY_FIELD),
    months: parseField(month, MONTH_FIELD),
    weekdays: new Set(weekdays),
    dayRestricted: !day.startsWith('*'),
    weekdayRestricted: !weekday.startsWith('*'),
  };
}

function dayMatches(spec: CronSpec, wall: Date): boolean {
  const dom = spec.days.has(wall.getUTCDate());
  const dow = spec.weekdays.has(wall.getUTCDay());
  if (spec.dayRestricted && spec.weekdayRestricted) return dom || dow;
  if (spec.dayRestricted) return dom;
  if (spec.weekdayRestricted) return dow;
  return true;
}

/** The next wall-clock minute (as a naive UTC ms) at or after `wall` that the spec matches; null within the limit. */
function nextWallMatch(spec: CronSpec, from: number, limit: number): number | null {
  let wall = from;
  while (wall <= limit) {
    const d = new Date(wall);
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth();
    const date = d.getUTCDate();
    if (!spec.months.has(month + 1)) wall = Date.UTC(year, month + 1, 1);
    else if (!dayMatches(spec, d)) wall = Date.UTC(year, month, date + 1);
    else if (!spec.hours.has(d.getUTCHours())) wall = Date.UTC(year, month, date, d.getUTCHours() + 1);
    else if (!spec.minutes.has(d.getUTCMinutes())) wall += MINUTE_MS;
    else return wall;
  }
  return null;
}

/**
 * First run strictly after `after`, matched on the wall clock `offsetMs` from UTC; null when none within 5 years.
 * One fixed offset: right for a zone without summer time (tests, fixed offsets); nextCronRunInZone follows DST.
 */
export function nextCronRun(spec: CronSpec, after: Date, offsetMs: number): Date | null {
  const from = Math.floor((after.getTime() + offsetMs) / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const wall = nextWallMatch(spec, from, from + SEARCH_LIMIT_MS);
  return wall === null ? null : new Date(wall - offsetMs);
}

/**
 * First run strictly after `after` in the zone `tz`, DST-safe: each matching wall time is placed with
 * the zone's offset at that time. A time inside a spring-forward gap runs at the first minute after the gap; in a
 * fall-back overlap it runs once, at the earlier instant.
 */
export function nextCronRunInZone(spec: CronSpec, after: Date, tz: string): Date | null {
  const afterMs = after.getTime();
  let from = Math.floor((afterMs + zoneOffsetMs(tz, afterMs)) / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = from + SEARCH_LIMIT_MS;
  while (from <= limit) {
    const wall = nextWallMatch(spec, from, limit);
    if (wall === null) return null;
    const d = new Date(wall);
    const at = wallTimeToUtc(tz, { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() });
    if (at > afterMs) return new Date(at);
    from = wall + MINUTE_MS;
  }
  return null;
}
