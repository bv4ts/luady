import { LIMITS, type ScheduleItemDTO, managerName } from '@luady/shared';
import { WEEKDAYS, isoFromInputs, whenWords } from './owner-time.js';

/** The repeating rules the board offers (owner time); anything else Luady set up is shown as it is. */
export type Rule =
  | { readonly kind: 'once'; readonly date: string; readonly time: string }
  | { readonly kind: 'daily'; readonly time: string }
  | { readonly kind: 'weekdays'; readonly time: string }
  | { readonly kind: 'weekly'; readonly weekday: number; readonly time: string };

export type RuleKind = Rule['kind'];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clock(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(h12)}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

const timeWords = (time: string): string => {
  const match = TIME_RE.exec(time);
  return match === null ? time : clock(Number(match[1]), Number(match[2]));
};

/**
 * The `when` the hub stores: an ISO time with the owner's offset for "once", a 5-field cron (minute hour day month
 * weekday, read in owner time) for the repeats. Monday to Friday are the working days. A string is an error.
 */
export function ruleToWhen(rule: Rule): { readonly when: string } | { readonly error: string } {
  const match = TIME_RE.exec(rule.time);
  if (match === null) return { error: 'Pick a time.' };
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  switch (rule.kind) {
    case 'once': {
      const iso = isoFromInputs(rule.date, rule.time);
      return iso === null ? { error: 'Pick a date.' } : { when: iso };
    }
    case 'daily': return { when: `${String(minute)} ${String(hour)} * * *` };
    case 'weekdays': return { when: `${String(minute)} ${String(hour)} * * 1-5` };
    case 'weekly':
      return rule.weekday >= 0 && rule.weekday <= 6 ? { when: `${String(minute)} ${String(hour)} * * ${String(rule.weekday)}` } : { error: 'Pick a day.' };
  }
}

const CRON_RE = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-7])$/;

/** A cron the board knows back into a rule (`0 9 * * 1-5` → every weekday at 9:00 AM); null for any other cron. */
export function cronToRule(cron: string): Rule | null {
  const match = CRON_RE.exec(cron.trim().replace(/\s+/g, ' '));
  if (match === null) return null;
  const [minute, hour, day] = [Number(match[1]), Number(match[2]), match[3] ?? ''];
  if (minute > 59 || hour > 23) return null;
  const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (day === '*') return { kind: 'daily', time };
  if (day === '1-5') return { kind: 'weekdays', time };
  return { kind: 'weekly', weekday: Number(day) % 7, time };
}

/** A rule said back in words before it is saved ("Every weekday at 9:00 AM", "Once, Tomorrow, 9:00 AM"). */
export function ruleWords(rule: Rule, now: number): string {
  switch (rule.kind) {
    case 'once': {
      const iso = isoFromInputs(rule.date, rule.time);
      return iso === null ? 'Once (pick a date and a time)' : `Once, ${whenWords(Date.parse(iso), now)}`;
    }
    case 'daily': return `Every day at ${timeWords(rule.time)}`;
    case 'weekdays': return `Every weekday (Monday to Friday) at ${timeWords(rule.time)}`;
    case 'weekly': return `Every ${WEEKDAYS[rule.weekday] ?? 'week'} at ${timeWords(rule.time)}`;
  }
}

/** A stored `when` in words: a rule the board knows, a single time, or Luady's own cron as it is. */
export function whenText(when: string, now: number): string {
  const rule = cronToRule(when);
  if (rule !== null) return ruleWords(rule, now);
  const at = Date.parse(when);
  if (/^\d{4}-\d{2}-\d{2}T/.test(when) && Number.isFinite(at)) return `Once, ${whenWords(at, now)}`;
  return `Repeats on ${managerName()}'s own rule (${when})`;
}

/** "Next: Tomorrow, 9:00 AM", or that it will not run again. */
export function nextText(item: Pick<ScheduleItemDTO, 'nextRunAt'>, now: number): string {
  const at = item.nextRunAt === null ? Number.NaN : Date.parse(item.nextRunAt);
  return Number.isFinite(at) ? `Next: ${whenWords(at, now)}` : 'Will not run again';
}

/** Soonest first; the ones that will not run again last. */
export function sortSchedules(items: readonly ScheduleItemDTO[]): readonly ScheduleItemDTO[] {
  const at = (item: ScheduleItemDTO): number => (item.nextRunAt === null ? Number.POSITIVE_INFINITY : Date.parse(item.nextRunAt));
  return items.toSorted((a, b) => at(a) - at(b) || a.id.localeCompare(b.id));
}

/** What the task box is missing; null when it is fine. */
export function taskError(task: string): string | null {
  const text = task.trim();
  if (text.length < LIMITS.scheduleTaskMin) return `Say what ${managerName()} should do (a few words at least).`;
  if (text.length > LIMITS.scheduleTaskMax) return 'Keep it under 2,000 characters.';
  return null;
}

/** A once-rule in the past cannot be scheduled. */
export function inPast(rule: Rule, now: number): boolean {
  if (rule.kind !== 'once') return false;
  const iso = isoFromInputs(rule.date, rule.time);
  return iso !== null && Date.parse(iso) <= now;
}
