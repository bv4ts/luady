import { afterEach, describe, expect, it } from 'vitest';
import { setOwnerZone } from '@luady/shared';
import { toIsoBound } from '../../src/meetings/service.js';
import { quietEndsAt } from '../../src/notices/fallback.js';

/** The start of a meeting search day and the end of quiet hours, checked across a DST change in New York and Sydney. */
afterEach(() => {
  setOwnerZone('Etc/GMT-4');
});

const quiet = (end: string) => ({ start: '23:00', end, tz: 'UTC' });
const at = (iso: string): Date => new Date(iso);

describe('quietEndsAt follows the owner zone across a DST change (notices/fallback.ts)', () => {
  it('America/New_York, spring forward (2026-03-08, a 23-hour day): 7:00 AM EDT, not 8:00', () => {
    setOwnerZone('America/New_York');
    // 01:00 EST on the change day.
    expect(quietEndsAt(at('2026-03-08T06:00:00.000Z'), quiet('07:00')).toISOString()).toBe('2026-03-08T11:00:00.000Z');
    // An end inside the gap (02:30 does not exist that day) is the first valid minute after it.
    expect(quietEndsAt(at('2026-03-08T06:00:00.000Z'), quiet('02:30')).toISOString()).toBe('2026-03-08T07:00:00.000Z');
  });

  it('America/New_York, fall back (2026-11-01, a 25-hour day): 7:00 AM EST, not 6:00', () => {
    setOwnerZone('America/New_York');
    expect(quietEndsAt(at('2026-11-01T04:00:00.000Z'), quiet('07:00')).toISOString()).toBe('2026-11-01T12:00:00.000Z');
  });

  it('Australia/Sydney, clocks forward (2026-10-04): 7:00 AM AEDT', () => {
    setOwnerZone('Australia/Sydney');
    // 00:00 AEST on 4 October.
    expect(quietEndsAt(at('2026-10-03T14:00:00.000Z'), quiet('07:00')).toISOString()).toBe('2026-10-03T20:00:00.000Z');
  });

  it('Australia/Sydney, clocks back (2026-04-05): 7:00 AM AEST', () => {
    setOwnerZone('Australia/Sydney');
    // 00:00 AEDT on 5 April.
    expect(quietEndsAt(at('2026-04-04T13:00:00.000Z'), quiet('07:00')).toISOString()).toBe('2026-04-04T21:00:00.000Z');
  });

  it('after today\'s end it is tomorrow\'s, and an end equal to now is the next one', () => {
    setOwnerZone('America/New_York');
    expect(quietEndsAt(at('2026-11-01T13:00:00.000Z'), quiet('07:00')).toISOString()).toBe('2026-11-02T12:00:00.000Z');
    expect(quietEndsAt(at('2026-11-01T12:00:00.000Z'), quiet('07:00')).toISOString()).toBe('2026-11-02T12:00:00.000Z');
  });
});

describe('a meeting search day starts at midnight in the owner zone (meetings/service.ts)', () => {
  it('America/New_York: EDT before the change, EST after it', () => {
    setOwnerZone('America/New_York');
    expect(toIsoBound('2026-10-31', 'since')).toBe('2026-10-31T04:00:00.000Z');
    expect(toIsoBound('2026-11-02', 'since')).toBe('2026-11-02T05:00:00.000Z');
    expect(toIsoBound('2026-03-08', 'since')).toBe('2026-03-08T05:00:00.000Z');
  });

  it('Australia/Sydney: AEDT and AEST', () => {
    setOwnerZone('Australia/Sydney');
    expect(toIsoBound('2026-01-15', 'since')).toBe('2026-01-14T13:00:00.000Z');
    expect(toIsoBound('2026-07-15', 'since')).toBe('2026-07-14T14:00:00.000Z');
  });

  it('refuses a day that does not exist', () => {
    expect(() => toIsoBound('2026-02-30', 'since')).toThrow(/YYYY-MM-DD/);
  });
});
