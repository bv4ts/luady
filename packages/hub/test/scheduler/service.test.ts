import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock, LuadyService } from '../../src/core/contracts.js';
import { ValidationError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { SCHEDULED_FOOTER, createScheduler } from '../../src/scheduler/service.js';
import { silentLogger } from '../../test/helpers/fakes.js';

const T0 = '2026-10-09T12:00:00.000Z';
const clock: Clock = { now: () => new Date() };

function setup() {
  const db = openMemoryDb();
  const postEvent = vi.fn(async (_text: string, _kind: 'Event' | 'Scheduled'): Promise<void> => undefined);
  const luady: LuadyService = {
    status: vi.fn(), start: vi.fn(), stop: vi.fn(), postOwnerMessage: vi.fn(), postEvent, messages: vi.fn(),
  };
  const onChange = vi.fn();
  const scheduler = createScheduler({ db, clock, log: silentLogger(), luady, onChange });
  return { db, scheduler, postEvent, onChange };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: new Date(T0) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createScheduler: change announcements', () => {
  it('announces an add, a real cancel and a run, and stays quiet otherwise', async () => {
    const t = setup();
    const task = t.scheduler.add('2026-10-09T12:01:00+00:00', 'Check the deploy');
    expect(t.onChange).toHaveBeenCalledTimes(1);
    expect(t.scheduler.cancel('nope')).toBe(false);
    expect(t.onChange).toHaveBeenCalledTimes(1);
    t.scheduler.add('2026-10-09T12:02:00+00:00', 'Second check');
    expect(t.scheduler.cancel(task.id)).toBe(true);
    expect(t.onChange).toHaveBeenCalledTimes(3);
    t.scheduler.start();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    t.scheduler.stop();
    expect(t.postEvent).toHaveBeenCalledTimes(1);
    expect(t.onChange).toHaveBeenCalledTimes(4);
  });
});

describe('createScheduler', () => {
  it('computes the next cron run in owner time and persists the schedule', () => {
    vi.setSystemTime(new Date('2026-10-09T23:00:00Z'));
    const t = setup();
    const task = t.scheduler.add('30 3 * * *', 'Write the nightly digest');
    expect(task).toMatchObject({ when: '30 3 * * *', task: 'Write the nightly digest', nextRunAt: '2026-10-09T23:30:00.000Z' });
    expect(t.scheduler.list()).toEqual([task]);
    expect(t.db.prepare('SELECT active FROM schedules WHERE id = ?').get(task.id)).toEqual({ active: 1 });
  });

  it('accepts an ISO datetime with offset as a one-shot', () => {
    const t = setup();
    expect(t.scheduler.add('2026-10-10T09:00:00+04:00', 'Check the birch deploy').nextRunAt).toBe('2026-10-10T05:00:00.000Z');
  });

  it('rejects past times, bad specs, never-running crons and empty tasks', () => {
    const t = setup();
    expect(() => t.scheduler.add('2026-10-09T11:00:00Z', 'Too late')).toThrow(ValidationError);
    expect(() => t.scheduler.add('next tuesday', 'Vague')).toThrow(ValidationError);
    expect(() => t.scheduler.add('0 0 31 2 *', 'Never')).toThrow(ValidationError);
    expect(() => t.scheduler.add('* * * * *', '   ')).toThrow(ValidationError);
    expect(t.scheduler.list()).toEqual([]);
  });

  it('fires a due one-shot once through luady.postEvent and deactivates it', async () => {
    const t = setup();
    t.scheduler.add('2026-10-09T12:01:00Z', 'Ping the owner about birch');
    t.scheduler.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.postEvent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.postEvent).toHaveBeenCalledWith(`Ping the owner about birch\n${SCHEDULED_FOOTER}`, 'Scheduled');
    expect(t.scheduler.list()).toEqual([]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.postEvent).toHaveBeenCalledTimes(1);
    t.scheduler.stop();
  });

  it('reschedules a cron task after each run', async () => {
    const t = setup();
    t.scheduler.add('*/1 * * * *', 'Minute check');
    t.scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.postEvent).toHaveBeenCalledTimes(1);
    expect(t.scheduler.list()[0]?.nextRunAt).toBe('2026-10-09T12:02:00.000Z');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.postEvent).toHaveBeenCalledTimes(2);
    t.scheduler.stop();
  });

  it('cancels a schedule once', async () => {
    const t = setup();
    const task = t.scheduler.add('2026-10-09T12:01:00Z', 'Cancelled task');
    expect(t.scheduler.cancel(task.id)).toBe(true);
    expect(t.scheduler.cancel(task.id)).toBe(false);
    t.scheduler.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.postEvent).not.toHaveBeenCalled();
    t.scheduler.stop();
  });

  it('catches up a missed run once on start', async () => {
    const t = setup();
    t.scheduler.add('2026-10-09T12:05:00Z', 'Missed while the hub was down');
    vi.setSystemTime(new Date('2026-10-09T12:30:00Z'));
    t.scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.postEvent).toHaveBeenCalledTimes(1);
    t.scheduler.stop();
  });

  it('logs a failing postEvent and still runs the next task', async () => {
    const t = setup();
    t.postEvent.mockRejectedValueOnce(new Error('brain down'));
    t.scheduler.add('2026-10-09T12:01:00Z', 'First');
    t.scheduler.add('2026-10-09T12:01:00+00:00', 'Second');
    t.scheduler.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.postEvent.mock.calls.map((c) => c[0])).toEqual([`First\n${SCHEDULED_FOOTER}`, `Second\n${SCHEDULED_FOOTER}`]);
    t.scheduler.stop();
  });
});
