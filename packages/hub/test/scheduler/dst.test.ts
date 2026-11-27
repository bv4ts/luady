import { afterEach, describe, expect, it } from 'vitest';
import { setOwnerZone } from '@luady/shared';
import { ownerDayBounds } from '../../src/daily/digest.js';
import { nextCronRunInZone, parseCron } from '../../src/scheduler/cron.js';
import { firstRunAt } from '../../src/scheduler/service.js';
import { ownerDayRange } from '../../src/timeline/index.js';

const HOUR = 3_600_000;
const span = (range: { from: string; to: string }): number => (Date.parse(range.to) - Date.parse(range.from)) / HOUR;

afterEach(() => {
  setOwnerZone('Etc/GMT-4');
});

describe('owner days across DST', () => {
  it('America/New_York: the spring day has 23 hours and the autumn day 25, from local midnight to local midnight', () => {
    setOwnerZone('America/New_York');
    expect(ownerDayBounds('2026-03-08')).toEqual({ from: '2026-03-08T05:00:00.000Z', to: '2026-03-09T04:00:00.000Z' });
    expect(span(ownerDayBounds('2026-03-08'))).toBe(23);
    expect(ownerDayBounds('2026-11-01')).toEqual({ from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T05:00:00.000Z' });
    expect(span(ownerDayBounds('2026-11-01'))).toBe(25);
    expect(span(ownerDayBounds('2026-07-01'))).toBe(24);
    expect(ownerDayRange('2026-03-08')).toEqual(ownerDayBounds('2026-03-08'));
    expect(ownerDayRange('2026-11-01')).toEqual(ownerDayBounds('2026-11-01'));
  });

  it('Australia/Sydney: the April day has 25 hours and the October day 23', () => {
    setOwnerZone('Australia/Sydney');
    expect(ownerDayBounds('2026-04-05')).toEqual({ from: '2026-04-04T13:00:00.000Z', to: '2026-04-05T14:00:00.000Z' });
    expect(span(ownerDayRange('2026-04-05'))).toBe(25);
    expect(ownerDayRange('2026-10-04')).toEqual({ from: '2026-10-03T14:00:00.000Z', to: '2026-10-04T13:00:00.000Z' });
    expect(span(ownerDayBounds('2026-10-04'))).toBe(23);
  });

  it('a zone without summer time keeps its fixed days (the test zone, Etc/GMT-4)', () => {
    expect(ownerDayBounds('2026-10-09')).toEqual({ from: '2026-10-08T20:00:00.000Z', to: '2026-10-09T20:00:00.000Z' });
    expect(() => ownerDayRange('2026-02-30')).toThrow(/Not a day/);
  });
});

describe('cron schedules across DST', () => {
  const next = (expr: string, afterIso: string, tz: string): string | null => nextCronRunInZone(parseCron(expr), new Date(afterIso), tz)?.toISOString() ?? null;

  it('America/New_York: 09:00 every day stays 09:00 local on both sides of the change', () => {
    const tz = 'America/New_York';
    expect(next('0 9 * * *', '2026-03-07T15:00:00Z', tz)).toBe('2026-03-08T13:00:00.000Z');
    expect(next('0 9 * * *', '2026-03-07T13:30:00Z', tz)).toBe('2026-03-07T14:00:00.000Z');
    expect(next('0 9 * * *', '2026-10-31T14:00:00Z', tz)).toBe('2026-11-01T14:00:00.000Z');
  });

  it('a time in the spring gap runs at the first minute after it; a time in the autumn overlap runs once, the earlier', () => {
    const tz = 'America/New_York';
    expect(next('30 2 * * *', '2026-03-08T05:00:00Z', tz)).toBe('2026-03-08T07:00:00.000Z');
    const first = next('30 1 * * *', '2026-10-31T12:00:00Z', tz);
    expect(first).toBe('2026-11-01T05:30:00.000Z');
    expect(next('30 1 * * *', first ?? '', tz)).toBe('2026-11-02T06:30:00.000Z');
  });

  it('Australia/Sydney: 09:00 every day across the April and October changes', () => {
    const tz = 'Australia/Sydney';
    expect(next('0 9 * * *', '2026-04-04T00:00:00Z', tz)).toBe('2026-04-04T23:00:00.000Z');
    expect(next('0 9 * * *', '2026-10-03T00:00:00Z', tz)).toBe('2026-10-03T22:00:00.000Z');
    expect(next('0 9 * * *', '2026-10-04T00:00:00Z', tz)).toBe('2026-10-04T22:00:00.000Z');
  });

  it('the scheduler places a cron in the owner\'s zone of the day it runs', () => {
    setOwnerZone('America/New_York');
    expect(firstRunAt('0 9 * * *', new Date('2026-03-07T15:00:00Z'))).toBe('2026-03-08T13:00:00.000Z');
    setOwnerZone('Australia/Sydney');
    expect(firstRunAt('0 9 * * 1-5', new Date('2026-04-04T00:00:00Z'))).toBe('2026-04-05T23:00:00.000Z');
  });
});
