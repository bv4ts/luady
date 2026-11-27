import { describe, expect, it } from 'vitest';
import { systemClock } from '../../src/core/clock.js';

describe('systemClock', () => {
  it('returns the current time as a fresh Date on every call', () => {
    const before = Date.now();
    const first = systemClock.now();
    const after = Date.now();
    expect(first).toBeInstanceOf(Date);
    expect(first.getTime()).toBeGreaterThanOrEqual(before);
    expect(first.getTime()).toBeLessThanOrEqual(after);
    expect(systemClock.now()).not.toBe(first);
  });
});
