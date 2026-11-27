import { afterEach, describe, expect, it } from 'vitest';
import {
  formatOffset, localDayBounds, localParts, ownerFormat, ownerZone, setOwnerZone, wallTimeToUtc, zoneOffsetMs,
} from '../../src/pure/owner-time.js';

const HOUR = 3_600_000;
const NY = 'America/New_York';
const SYDNEY = 'Australia/Sydney';
const GMT4 = 'Etc/GMT-4';

afterEach(() => {
  setOwnerZone(GMT4);
});

describe('the owner zone', () => {
  it('is set by the test setup, refuses an unknown zone, and is read at call time by ownerFormat', () => {
    expect(ownerZone()).toBe(GMT4);
    const clock = ownerFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const at = Date.UTC(2026, 10, 21, 8, 0);
    expect(clock.format(at)).toBe('12:00');
    expect(setOwnerZone('Mars/Olympus')).toBe(false);
    expect(ownerZone()).toBe(GMT4);
    expect(setOwnerZone(NY)).toBe(true);
    expect(clock.format(at)).toBe('03:00');
  });
});

describe('Etc/GMT-4, a fixed zone that is not UTC, gives the plain +4 h maths', () => {
  it('has a +4 h offset all year and 24 h days starting at 20:00 UTC', () => {
    for (const month of [0, 3, 6, 9]) expect(zoneOffsetMs(GMT4, Date.UTC(2026, month, 15, 12))).toBe(4 * HOUR);
    const { start, end } = localDayBounds(GMT4, Date.UTC(2026, 10, 21, 8));
    expect(new Date(start).toISOString()).toBe('2026-11-20T20:00:00.000Z');
    expect(end - start).toBe(24 * HOUR);
    expect(localParts(GMT4, Date.UTC(2026, 10, 21, 21, 30))).toMatchObject({ year: 2026, month: 11, day: 22, hour: 1, minute: 30, weekday: 0 });
  });
});

describe('DST in America/New_York and Australia/Sydney', () => {
  it('has a 23-hour day when clocks go forward and a 25-hour day when they go back', () => {
    const spring = localDayBounds(NY, Date.UTC(2026, 2, 8, 15));
    expect(spring.end - spring.start).toBe(23 * HOUR);
    const fall = localDayBounds(NY, Date.UTC(2026, 10, 1, 15));
    expect(fall.end - fall.start).toBe(25 * HOUR);
    const sydneyBack = localDayBounds(SYDNEY, Date.UTC(2026, 3, 5, 2));
    expect(sydneyBack.end - sydneyBack.start).toBe(25 * HOUR);
    const sydneyForward = localDayBounds(SYDNEY, Date.UTC(2026, 9, 4, 2));
    expect(sydneyForward.end - sydneyForward.start).toBe(23 * HOUR);
  });

  it('a wall time in the gap moves to the first valid minute after it', () => {
    const at = wallTimeToUtc(NY, { year: 2026, month: 3, day: 8, hour: 2, minute: 30 });
    expect(new Date(at).toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(localParts(NY, at)).toMatchObject({ hour: 3, minute: 0 });
  });

  it('a wall time in the overlap takes the earlier instant', () => {
    const at = wallTimeToUtc(NY, { year: 2026, month: 11, day: 1, hour: 1, minute: 30 });
    expect(new Date(at).toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('an ordinary wall time round-trips', () => {
    const at = wallTimeToUtc(SYDNEY, { year: 2026, month: 7, day: 1, hour: 9, minute: 15 });
    expect(localParts(SYDNEY, at)).toMatchObject({ year: 2026, month: 7, day: 1, hour: 9, minute: 15 });
  });
});

describe('formatOffset', () => {
  it('formats signed hours and minutes', () => {
    expect(formatOffset(240)).toBe('+04:00');
    expect(formatOffset(-300)).toBe('-05:00');
    expect(formatOffset(330)).toBe('+05:30');
    expect(formatOffset(0)).toBe('+00:00');
  });
});
