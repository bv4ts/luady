import { describe, expect, it } from 'vitest';
import { DAWN, DUSK, ambienceAt, ownerMinutes } from '../src/ambience.js';

/** Epoch ms of an owner wall-clock time on 15 November 2026 (the test zone, UTC+4). */
const ownerClock = (h: number, m = 0): number => Date.UTC(2026, 10, 15, h - 4, m);

describe('ambienceAt', () => {
  it('is deep night at 3:00 AM', () => {
    expect(ambienceAt(ownerClock(3))).toEqual({ phase: 'night', light: 0 });
  });

  it('is halfway through dawn at 6:15 AM', () => {
    const a = ambienceAt(ownerClock(6, 15));
    expect(a.phase).toBe('dawn');
    expect(a.light).toBeCloseTo(0.5, 9);
  });

  it('is full day at noon', () => {
    expect(ambienceAt(ownerClock(12))).toEqual({ phase: 'day', light: 1 });
  });

  it('is in dusk at 6:00 PM, on the way down', () => {
    const a = ambienceAt(ownerClock(18));
    expect(a.phase).toBe('dusk');
    const t = (18 * 60 - DUSK.from) / (DUSK.to - DUSK.from);
    expect(a.light).toBeCloseTo(1 - t * t * (3 - 2 * t), 9);
    expect(a.light).toBeGreaterThan(0);
    expect(a.light).toBeLessThan(1);
  });

  it('is night again at 9:00 PM', () => {
    expect(ambienceAt(ownerClock(21))).toEqual({ phase: 'night', light: 0 });
  });

  it('ramps smoothly and only one way through dawn and dusk', () => {
    const at = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ambienceAt(ownerClock(0, from + i)).light);
    const up = at(DAWN.from, DAWN.to - 1);
    const down = at(DUSK.from, DUSK.to - 1);
    up.slice(1).forEach((v, i) => expect(v).toBeGreaterThanOrEqual(up[i]!));
    down.slice(1).forEach((v, i) => expect(v).toBeLessThanOrEqual(down[i]!));
    [...up, ...down].slice(1).forEach((v, i, all) => i > 0 && expect(Math.abs(v - all[i - 1]!)).toBeLessThan(0.05));
    expect(ambienceAt(ownerClock(5, 44)).phase).toBe('night');
    expect(ambienceAt(ownerClock(6, 45))).toEqual({ phase: 'day', light: 1 });
    expect(ambienceAt(ownerClock(17, 29))).toEqual({ phase: 'day', light: 1 });
    expect(ambienceAt(ownerClock(18, 45))).toEqual({ phase: 'night', light: 0 });
  });

  it('reads owner time whatever the day, and treats nonsense as night', () => {
    expect(ownerMinutes(ownerClock(0, 30))).toBeCloseTo(30, 9);
    expect(ambienceAt(ownerClock(12) + 86_400_000 * 40)).toEqual({ phase: 'day', light: 1 });
    expect(ambienceAt(Number.NaN)).toEqual({ phase: 'night', light: 0 });
    expect(ownerMinutes(Number.NaN)).toBeNaN();
  });
});

describe('ambienceAt in a time zone', () => {
  it("gives the same numbers in Etc/GMT-4 as with no zone, the zone the tests run in by default", () => {
    const minutes = Array.from({ length: 24 * 12 }, (_, i) => ownerClock(0, i * 5) + 1234);
    minutes.forEach((ms) => {
      expect(ambienceAt(ms, 'Etc/GMT-4')).toEqual(ambienceAt(ms));
      // The plain fixed-offset formula; it loses about 1e-9 minutes to floating point on present-day epoch values.
      const old = (((ms / 60_000 + 240) % 1440) + 1440) % 1440;
      expect(ownerMinutes(ms, 'Etc/GMT-4')).toBeCloseTo(old, 6);
    });
  });

  it('reads the local wall clock of the zone it is given', () => {
    expect(ambienceAt(Date.UTC(2026, 10, 15, 12), 'UTC')).toEqual({ phase: 'day', light: 1 });
    expect(ambienceAt(Date.UTC(2026, 10, 15, 12), 'Pacific/Auckland')).toEqual({ phase: 'night', light: 0 });
    expect(ownerMinutes(Date.UTC(2026, 10, 15, 0, 30), 'UTC')).toBeCloseTo(30, 9);
  });

  it('falls back to the owner zone for a zone Intl does not know', () => {
    expect(ambienceAt(ownerClock(12), 'Not/AZone')).toEqual({ phase: 'day', light: 1 });
  });

  /** Epoch ms of a local wall-clock time in a zone, found by search (the test does not trust the code under test). */
  const localClock = (tz: string, y: number, mo: number, d: number, h: number, mi: number): number => {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    const want = `${mo}/${d}/${y}, ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
    for (let ms = Date.UTC(y, mo - 1, d) - 86_400_000; ms < Date.UTC(y, mo - 1, d) + 2 * 86_400_000; ms += 60_000) {
      if (fmt.format(ms) === want) return ms;
    }
    throw new Error(`no ${want} in ${tz}`);
  };

  it.each([
    ['America/New_York', 2026, 3, 8],
    ['America/New_York', 2026, 11, 1],
    ['Australia/Sydney', 2026, 4, 5],
    ['Australia/Sydney', 2026, 10, 4],
  ] as const)('keeps dawn and dusk at fixed local times across the DST change in %s on %i-%i-%i', (tz, y, mo, d) => {
    expect(ambienceAt(localClock(tz, y, mo, d, 3, 0), tz)).toEqual({ phase: 'night', light: 0 });
    expect(ambienceAt(localClock(tz, y, mo, d, 6, 15), tz).light).toBeCloseTo(0.5, 9);
    expect(ambienceAt(localClock(tz, y, mo, d, 12, 0), tz)).toEqual({ phase: 'day', light: 1 });
    expect(ambienceAt(localClock(tz, y, mo, d, 18, 45), tz)).toEqual({ phase: 'night', light: 0 });
    expect(ownerMinutes(localClock(tz, y, mo, d, 17, 30), tz)).toBeCloseTo(17 * 60 + 30, 9);
  });
});
