import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { clock12, ownerParts, humanDuration, inQuietHours, injectionStamp, isoNow } from '../../src/core/time.js';

const NIGHT = { start: '00:00', end: '08:00', tz: 'Etc/GMT-4' } as const;
const LATE = { start: '22:00', end: '06:00', tz: 'Etc/GMT-4' } as const;
const NEVER = { start: '08:00', end: '08:00', tz: 'Etc/GMT-4' } as const;
const DAY = { start: '09:00', end: '17:00', tz: 'Etc/GMT-4' } as const;

const at = (iso: string): Date => new Date(iso);

describe('host time zone guard', () => {
  it('runs under TZ=UTC so local-time bugs cannot hide behind the machine\'s own zone', () => {
    expect(process.env.TZ).toBe('UTC');
    expect(at('2026-10-09T15:42:00Z').getHours()).toBe(15);
  });
});

describe('isoNow', () => {
  it('formats the injected clock as ISO-8601 UTC', () => {
    expect(isoNow({ now: () => at('2026-10-09T12:00:00Z') })).toBe('2026-10-09T12:00:00.000Z');
  });
});

describe('ownerParts', () => {
  it.each([
    ['2026-10-09T15:42:00Z', 'Fri', '19:42', 1182],
    ['2026-10-09T15:42:59.999Z', 'Fri', '19:42', 1182],
    ['2026-10-09T19:59:00Z', 'Fri', '23:59', 1439],
    ['2026-10-09T20:00:00Z', 'Sat', '00:00', 0],
    ['2026-10-10T04:00:00Z', 'Sat', '08:00', 480],
  ])('%s is %s %s in owner time', (iso, weekday, hhmm, minutes) => {
    expect(ownerParts(at(iso))).toEqual({ hhmm, weekday, minutes });
  });

  it('throws ValidationError for an invalid Date', () => {
    expect(() => ownerParts(new Date('not a date'))).toThrow(ValidationError);
  });
});

describe('injectionStamp', () => {
  it.each([
    ['2026-10-09T15:42:00Z', 'Fri 19:42'],
    ['2026-10-09T20:30:00Z', 'Sat 00:30'],
  ])('%s -> %s', (iso, stamp) => {
    expect(injectionStamp(at(iso))).toBe(stamp);
  });
});

describe('inQuietHours', () => {
  it.each([
    ['2026-10-09T20:00:00Z', true], // 00:00 owner time, start is inclusive
    ['2026-10-10T03:59:00Z', true], // 07:59
    ['2026-10-10T04:00:00Z', false], // 08:00, end is exclusive
    ['2026-10-09T19:59:00Z', false], // 23:59
    ['2026-10-09T12:00:00Z', false], // 16:00
  ])('default 00:00-08:00 window at %s -> %s', (iso, expected) => {
    expect(inQuietHours(at(iso), NIGHT)).toBe(expected);
  });

  it.each([
    ['2026-10-09T18:00:00Z', true], // 22:00
    ['2026-10-09T17:59:00Z', false], // 21:59
    ['2026-10-09T19:59:00Z', true], // 23:59
    ['2026-10-09T20:00:00Z', true], // 00:00
    ['2026-10-10T01:59:00Z', true], // 05:59
    ['2026-10-10T02:00:00Z', false], // 06:00
    ['2026-10-09T08:00:00Z', false], // 12:00
  ])('window crossing midnight 22:00-06:00 at %s -> %s', (iso, expected) => {
    expect(inQuietHours(at(iso), LATE)).toBe(expected);
  });

  it.each(['2026-10-09T04:00:00Z', '2026-10-09T03:59:00Z', '2026-10-09T12:00:00Z'])(
    'start == end means never (at %s)',
    (iso) => {
      expect(inQuietHours(at(iso), NEVER)).toBe(false);
    },
  );

  it.each([
    ['2026-10-09T05:00:00Z', true], // 09:00
    ['2026-10-09T12:59:00Z', true], // 16:59
    ['2026-10-09T13:00:00Z', false], // 17:00
    ['2026-10-09T04:59:00Z', false], // 08:59
  ])('daytime 09:00-17:00 window at %s -> %s', (iso, expected) => {
    expect(inQuietHours(at(iso), DAY)).toBe(expected);
  });

  it('throws ValidationError for a malformed HH:MM', () => {
    const bad = { start: '8:00', end: '09:00', tz: 'Etc/GMT-4' } as const;
    expect(() => inQuietHours(at('2026-10-09T12:00:00Z'), bad)).toThrow(ValidationError);
  });
});

describe('humanDuration', () => {
  it.each([
    [45, '45s'],
    [840, '14m'],
    [7500, '2h05m'],
    [0, '0s'],
    [59.9, '59s'],
    [60, '1m'],
    [3599, '59m'],
    [3600, '1h00m'],
    [86400, '24h00m'],
    [-5, '0s'],
    [Number.NaN, '0s'],
    [Number.POSITIVE_INFINITY, '0s'],
  ])('%d seconds -> %s', (sec, text) => {
    expect(humanDuration(sec)).toBe(text);
  });

  it('clock12 shows owner time with AM/PM', () => {
    expect(clock12(new Date('2026-10-10T11:05:00Z'))).toBe('3:05 PM');
    expect(clock12(new Date('2026-10-09T20:30:00Z'))).toBe('12:30 AM');
    expect(clock12(new Date('2026-10-10T08:00:00Z'))).toBe('12:00 PM');
    expect(clock12(new Date('2026-10-10T05:59:00Z'))).toBe('9:59 AM');
  });
});
