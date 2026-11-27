import { afterEach, describe, expect, it } from 'vitest';
import { setOwnerZone } from '@luady/shared';
import {
  clockText, dayKey, dayStart, dayWords, isoFromInputs, ownerMs, ownerParts, startOfOwnerDay, timeInput,
} from '../../../../src/features/agency/drawers/schedule/owner-time.js';

const HOUR = 3_600_000;

afterEach(() => {
  setOwnerZone('Etc/GMT-4');
});

describe('the schedule time module across DST', () => {
  it('America/New_York: a wall time is placed with the offset of its own day', () => {
    setOwnerZone('America/New_York');
    expect(new Date(ownerMs(2026, 3, 7, 9)).toISOString()).toBe('2026-03-07T14:00:00.000Z');
    expect(new Date(ownerMs(2026, 3, 8, 9)).toISOString()).toBe('2026-03-08T13:00:00.000Z');
    expect(isoFromInputs('2026-03-07', '09:00')).toBe('2026-03-07T09:00:00-05:00');
    expect(isoFromInputs('2026-03-08', '09:00')).toBe('2026-03-08T09:00:00-04:00');
    expect(Date.parse(isoFromInputs('2026-11-01', '09:00') ?? '')).toBe(Date.parse('2026-11-01T14:00:00Z'));
  });

  it('the spring day is 23 hours and the autumn day 25; day keys, starts and words follow the calendar', () => {
    setOwnerZone('America/New_York');
    const spring = dayStart('2026-03-08') ?? 0;
    expect(((dayStart('2026-03-09') ?? 0) - spring) / HOUR).toBe(23);
    expect(((dayStart('2026-11-02') ?? 0) - (dayStart('2026-11-01') ?? 0)) / HOUR).toBe(25);
    expect(startOfOwnerDay(spring + 20 * HOUR)).toBe(spring);
    expect(dayKey(spring + 22.5 * HOUR)).toBe('2026-03-08');
    expect(dayWords(dayStart('2026-03-09') ?? 0, spring + 30 * 60_000)).toBe('Tomorrow');
    // 24.5 hours into the 25-hour day is still that day (23:30), and the next midnight is tomorrow.
    expect(dayWords((dayStart('2026-11-01') ?? 0) + 24.5 * HOUR, dayStart('2026-11-01') ?? 0)).toBe('Today');
    expect(dayWords(dayStart('2026-11-02') ?? 0, (dayStart('2026-11-01') ?? 0) + 24.5 * HOUR)).toBe('Tomorrow');
  });

  it('a time in the spring gap moves to the first minute after it; one in the autumn overlap takes the earlier', () => {
    setOwnerZone('America/New_York');
    expect(isoFromInputs('2026-03-08', '02:30')).toBe('2026-03-08T03:00:00-04:00');
    expect(new Date(ownerMs(2026, 11, 1, 1, 30)).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(clockText(ownerMs(2026, 11, 1, 1, 30))).toBe('1:30 AM');
    expect(timeInput(Date.parse('2026-11-01T06:30:00Z'))).toBe('01:30');
  });

  it('Australia/Sydney: the April day is 25 hours, the October day 23, and 09:00 stays 09:00', () => {
    setOwnerZone('Australia/Sydney');
    expect(((dayStart('2026-04-06') ?? 0) - (dayStart('2026-04-05') ?? 0)) / HOUR).toBe(25);
    expect(((dayStart('2026-10-05') ?? 0) - (dayStart('2026-10-04') ?? 0)) / HOUR).toBe(23);
    expect(isoFromInputs('2026-04-04', '09:00')).toBe('2026-04-04T09:00:00+11:00');
    expect(isoFromInputs('2026-04-05', '09:00')).toBe('2026-04-05T09:00:00+10:00');
    expect(ownerParts(Date.parse('2026-10-04T22:00:00Z'))).toMatchObject({ year: 2026, month: 10, day: 5, hour: 9, minute: 0, weekday: 1 });
  });

  it('keeps the test zone\'s fixed answers (Etc/GMT-4) and refuses dates that do not exist', () => {
    expect(isoFromInputs('2026-11-20', '09:00')).toBe('2026-11-20T09:00:00+04:00');
    expect(dayStart('2026-02-30')).toBeNull();
    expect(isoFromInputs('2026-11-20', '9:00')).toBeNull();
  });
});
