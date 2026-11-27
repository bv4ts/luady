import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { nextCronRun, parseCron } from '../../src/scheduler/cron.js';
import { ownerDateKey, zoneOffsetMs } from '../../src/scheduler/zone.js';

const OWNER_OFFSET_MS = 4 * 3_600_000;

function next(expr: string, afterIso: string): string | null {
  const run = nextCronRun(parseCron(expr), new Date(afterIso), OWNER_OFFSET_MS);
  return run ? run.toISOString() : null;
}

describe('zone', () => {
  it('reads the test zone as UTC+4 and computes the owner calendar date', () => {
    expect(zoneOffsetMs(new Date('2026-10-09T12:00:00Z'))).toBe(OWNER_OFFSET_MS);
    expect(ownerDateKey(new Date('2026-10-09T19:59:00Z'))).toBe('2026-10-09');
    expect(ownerDateKey(new Date('2026-10-09T20:00:00Z'))).toBe('2026-10-10');
  });
});

describe('nextCronRun', () => {
  it('runs "30 3 * * *" at 03:30 owner time', () => {
    expect(next('30 3 * * *', '2026-10-09T23:00:00Z')).toBe('2026-10-09T23:30:00.000Z');
  });

  it('is strictly after the given instant', () => {
    expect(next('30 3 * * *', '2026-10-09T23:30:00Z')).toBe('2026-10-10T23:30:00.000Z');
  });

  it('supports steps, lists and ranges', () => {
    expect(next('*/15 * * * *', '2026-10-09T12:07:00Z')).toBe('2026-10-09T12:15:00.000Z');
    expect(next('0,30 8 * * *', '2026-10-09T04:10:00Z')).toBe('2026-10-09T04:30:00.000Z');
    expect(next('0 9 * * 1-5', '2026-10-09T12:00:00Z')).toBe('2026-10-12T05:00:00.000Z');
    expect(next('0 10-16/3 * * *', '2026-10-09T08:30:00Z')).toBe('2026-10-09T09:00:00.000Z');
  });

  it('treats day-of-month and day-of-week as either-or, and 7 as Sunday', () => {
    expect(next('0 12 13 * 5', '2026-10-09T09:00:00Z')).toBe('2026-10-13T08:00:00.000Z');
    expect(next('0 8 * * 7', '2026-10-09T12:00:00Z')).toBe('2026-10-11T04:00:00.000Z');
  });

  it('returns null for a date that never exists', () => {
    expect(next('0 0 31 2 *', '2026-10-09T12:00:00Z')).toBeNull();
  });
});

describe('parseCron', () => {
  it('rejects malformed expressions', () => {
    const bad = ['* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '5-1 * * * *', '*/0 * * * *', 'a * * * *'];
    for (const expr of bad) expect(() => parseCron(expr)).toThrow(ValidationError);
  });
});
