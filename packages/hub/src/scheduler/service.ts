import { z } from 'zod';
import type { Clock, Db, LuadyService, Logger, ScheduledTask, Scheduler } from '../core/contracts.js';
import { ValidationError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { nextCronRunInZone, parseCron } from './cron.js';
import { zoneOffsetMs } from './zone.js';
import { formatOffset, managerName, ownerZone } from '@luady/shared';

/** Appended to every scheduled task so the brain knows where its reply goes (see luady/replies.ts). */
export const SCHEDULED_FOOTER =
  '(Your final reply to this goes to the owner: on their screen when the website is open, otherwise on their chat channel. If there is nothing worth telling them now, reply exactly NO_UPDATE and nothing is sent. Cancel recurring checks with schedule_cancel once the work is done.)';

export interface SchedulerDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  luady: LuadyService;
  /** A schedule was added, cancelled or ran (app.ts turns it into `schedules.changed`). */
  onChange?: () => void;
  /**
   * The manager switch: while it is off nothing runs and nothing is advanced, so a schedule that came
   * due runs once when the manager is back. Absent: always on.
   */
  active?: () => boolean;
}

export const SCHEDULER_TICK_MS = 30_000;
const TASK_MAX_CHARS = 2000;
const IsoWithOffsetSchema = z.iso.datetime({ offset: true });

interface ScheduleRow {
  id: string;
  when_spec: string;
  task: string;
  next_run_at: string | null;
}

const isIsoWhen = (when: string): boolean => IsoWithOffsetSchema.safeParse(when).success;

/** In the owner's zone, DST-safe: each run is placed with the offset of its own day. */
function nextCronIso(when: string, after: Date): string | null {
  return nextCronRunInZone(parseCron(when), after, ownerZone())?.toISOString() ?? null;
}

/** First run strictly after `now`. Throws ValidationError for a bad spec, a past time, or a cron that never runs. */
/** "2026-10-10T09:00:00+02:00": tomorrow at 09:00 with the owner's offset then (DST-safe). */
function isoExample(now: Date): string {
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60_000);
  const offset = zoneOffsetMs(tomorrow);
  const day = new Date(tomorrow.getTime() + offset).toISOString().slice(0, 10);
  return `${day}T09:00:00${formatOffset(Math.round(offset / 60_000))}`;
}

export function firstRunAt(when: string, now: Date): string {
  if (isIsoWhen(when)) {
    const at = new Date(when);
    if (at.getTime() <= now.getTime()) throw new ValidationError('That time is already in the past');
    return at.toISOString();
  }
  let next: string | null;
  try {
    next = nextCronIso(when, now);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'invalid';
    throw new ValidationError(`Use an ISO datetime with offset (${isoExample(now)}) or a 5-field cron: ${detail}`);
  }
  if (next === null) throw new ValidationError('That cron expression never runs');
  return next;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  const insert = deps.db.prepare<[string, string, string, string, string]>(
    'INSERT INTO schedules (id, when_spec, task, next_run_at, created_at, active) VALUES (?, ?, ?, ?, ?, 1)',
  );
  const selectActive = deps.db.prepare<[], ScheduleRow>(
    'SELECT id, when_spec, task, next_run_at FROM schedules WHERE active = 1 ORDER BY next_run_at, created_at, rowid',
  );
  const selectDue = deps.db.prepare<[string], ScheduleRow>(
    `SELECT id, when_spec, task, next_run_at FROM schedules
     WHERE active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at, created_at, rowid`,
  );
  const deactivate = deps.db.prepare<[string]>('UPDATE schedules SET active = 0 WHERE id = ? AND active = 1');
  const advance = deps.db.prepare<[string | null, number, string]>(
    'UPDATE schedules SET next_run_at = ?, active = ? WHERE id = ?',
  );

  const toTask = (row: ScheduleRow): ScheduledTask => ({
    id: row.id, when: row.when_spec, task: row.task, nextRunAt: row.next_run_at,
  });

  function add(when: string, task: string): ScheduledTask {
    const spec = when.trim();
    const text = task.trim();
    if (text.length === 0 || text.length > TASK_MAX_CHARS) throw new ValidationError('The task must be 1 to 2000 characters');
    const now = deps.clock.now();
    const nextRunAt = firstRunAt(spec, now);
    const id = newId();
    insert.run(id, spec, text, nextRunAt, now.toISOString());
    deps.onChange?.();
    return { id, when: spec, task: text, nextRunAt };
  }

  function reschedule(row: ScheduleRow, now: Date): void {
    let next: string | null = null;
    if (!isIsoWhen(row.when_spec)) {
      try {
        next = nextCronIso(row.when_spec, now);
      } catch (err) {
        deps.log.error({ err, id: row.id }, 'scheduler: stored cron is invalid');
      }
    }
    advance.run(next, next === null ? 0 : 1, row.id);
  }

  async function fire(row: ScheduleRow): Promise<void> {
    try {
      await deps.luady.postEvent(`${row.task}\n${SCHEDULED_FOOTER}`, 'Scheduled');
    } catch (err) {
      deps.log.error({ err, id: row.id }, `scheduler: could not hand the task to ${managerName()}`);
    }
  }

  async function tick(): Promise<void> {
    if (ticking || deps.active?.() === false) return;
    ticking = true;
    try {
      const now = deps.clock.now();
      const due = selectDue.all(now.toISOString());
      for (const row of due) {
        reschedule(row, now);
        await fire(row);
      }
      if (due.length > 0) deps.onChange?.();
    } catch (err) {
      deps.log.error({ err }, 'scheduler: tick failed');
    } finally {
      ticking = false;
    }
  }

  return {
    add,
    list: () => selectActive.all().map(toTask),
    cancel: (id) => {
      const cancelled = deactivate.run(id).changes > 0;
      if (cancelled) deps.onChange?.();
      return cancelled;
    },
    start: () => {
      if (timer !== null) return;
      timer = setInterval(() => void tick(), SCHEDULER_TICK_MS);
      void tick();
    },
    stop: () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
