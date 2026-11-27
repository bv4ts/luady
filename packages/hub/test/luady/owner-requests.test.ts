import { describe, expect, it } from 'vitest';
import { OWNER_REQUEST_TTL_MS, createOwnerRequests } from '../../src/luady/owner-requests.js';
import { createFakeClock } from '../helpers/fakes.js';

describe('owner requests', () => {
  it('a marked prompt is taken once; any other prompt never', () => {
    const marks = createOwnerRequests(createFakeClock('2026-10-09T12:00:00.000Z'));
    marks.mark('a'.repeat(64));
    expect(marks.take('b'.repeat(64))).toBe(false);
    expect(marks.take('a'.repeat(64))).toBe(true);
    expect(marks.take('a'.repeat(64))).toBe(false);
  });

  it('a mark whose prompt never came runs out', () => {
    const clock = createFakeClock('2026-10-09T12:00:00.000Z');
    const marks = createOwnerRequests(clock);
    marks.mark('c'.repeat(64));
    clock.advance(OWNER_REQUEST_TTL_MS + 1);
    expect(marks.take('c'.repeat(64))).toBe(false);
  });
});
