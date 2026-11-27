import { setOwnerZone } from '@luady/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { whenText } from '../../../../src/features/agency/drawers/board/when.js';
import { sinceWords } from '../../../../src/features/agency/hud/WelcomeBack.js';
import { isQuietAt } from '../../../../src/features/agency/model/useAmbience.js';

/** The office's three time sites follow the owner's zone across DST, in America/New_York. */
afterEach(() => {
  setOwnerZone('Etc/GMT-4');
});

const at = (iso: string): number => Date.parse(iso);

describe('quiet hours (useAmbience) in America/New_York', () => {
  const night = { start: '22:00', end: '07:00' };

  it('reads the wall clock with the offset of the day: 06:30 is quiet and 07:30 is not, before and after each change', () => {
    setOwnerZone('America/New_York');
    // 2026-03-07 is EST (UTC-5), 2026-03-09 is EDT (UTC-4).
    expect(isQuietAt(at('2026-03-07T11:30:00Z'), night)).toBe(true);
    expect(isQuietAt(at('2026-03-07T12:30:00Z'), night)).toBe(false);
    expect(isQuietAt(at('2026-03-09T10:30:00Z'), night)).toBe(true);
    expect(isQuietAt(at('2026-03-09T11:30:00Z'), night)).toBe(false);
    // 2026-11-02 is back to EST.
    expect(isQuietAt(at('2026-11-02T11:30:00Z'), night)).toBe(true);
    expect(isQuietAt(at('2026-11-02T12:30:00Z'), night)).toBe(false);
  });

  it('22:00 starts the quiet hours on the day the clocks go back', () => {
    setOwnerZone('America/New_York');
    expect(isQuietAt(at('2026-11-02T02:59:00Z'), night)).toBe(false);
    expect(isQuietAt(at('2026-11-02T03:00:00Z'), night)).toBe(true);
  });
});

describe('the welcome-back times (sinceWords) in America/New_York', () => {
  it('"Yesterday" means the calendar day before, also across the 23-hour spring day', () => {
    setOwnerZone('America/New_York');
    // Now: 00:30 EDT on 2026-03-09. 22:00 EDT on 03-08 is yesterday; 23:00 EST on 03-07 is two days ago.
    const now = at('2026-03-09T04:30:00Z');
    expect(sinceWords('2026-03-09T02:00:00Z', now)).toBe('Yesterday, 10:00 PM');
    expect(sinceWords('2026-03-08T04:00:00Z', now)).toBe('Mar 7, 11:00 PM');
  });

  it('a time earlier on the 25-hour autumn day is still today', () => {
    setOwnerZone('America/New_York');
    // Now: 23:30 EST on 2026-11-01; 00:30 EDT the same day is 24 hours earlier.
    const now = at('2026-11-02T04:30:00Z');
    expect(sinceWords('2026-11-01T04:30:00Z', now)).toBe('12:30 AM');
    expect(sinceWords('2026-11-01T03:30:00Z', now)).toBe('Yesterday, 11:30 PM');
  });
});

describe('board times (whenText) in America/New_York', () => {
  it('"Yesterday" is the calendar day before across the spring change', () => {
    setOwnerZone('America/New_York');
    const now = at('2026-03-09T04:30:00Z');
    expect(whenText('2026-03-09T02:00:00Z', now)).toBe('Yesterday, 10:00 PM');
    expect(whenText('2026-03-08T04:00:00Z', now)).toBe('Mar 7, 11:00 PM');
  });

  it('the start of the 25-hour autumn day is today, the evening before it yesterday', () => {
    setOwnerZone('America/New_York');
    const now = at('2026-11-02T04:30:00Z');
    expect(whenText('2026-11-01T04:30:00Z', now)).toBe('12:30 AM');
    expect(whenText('2026-11-01T03:30:00Z', now)).toBe('Yesterday, 11:30 PM');
  });
});
