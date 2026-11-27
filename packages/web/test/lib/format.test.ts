import { describe, expect, it } from 'vitest';
import { basename, ownerTime, formatBytes, formatKb, formatUptime, percentUsed, timeAgo, truncate } from '../../src/lib/format.js';

const now = Date.parse('2026-10-09T12:00:00.000Z');

describe('format helpers', () => {
  it('timeAgo renders compact relative times', () => {
    expect(timeAgo(null, now)).toBe('—');
    expect(timeAgo('not a date', now)).toBe('—');
    expect(timeAgo('2026-10-09T11:59:40.000Z', now)).toBe('just now');
    expect(timeAgo('2026-10-09T11:46:00.000Z', now)).toBe('14m ago');
    expect(timeAgo('2026-10-09T09:00:00.000Z', now)).toBe('3h ago');
    expect(timeAgo('2026-10-07T12:00:00.000Z', now)).toBe('2d ago');
  });

  it('ownerTime renders HH:MM in the owner zone (Etc/GMT-4 in these tests)', () => {
    expect(ownerTime('2026-10-09T12:30:00.000Z')).toBe('16:30');
    expect(ownerTime('garbage')).toBeNull();
  });

  it('formats sizes, percentages, uptime and text', () => {
    expect(formatKb(5_976_883)).toBe('5.7 GB');
    expect(formatKb(20_971_520)).toBe('20 GB');
    expect(formatKb(512_000)).toBe('500 MB');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(percentUsed(8_000_000, 2_000_000)).toBe(75);
    expect(percentUsed(0, 0)).toBe(0);
    expect(formatUptime(90_061)).toBe('1d 1h');
    expect(formatUptime(3_900)).toBe('1h 5m');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
    expect(basename('/home/dev/projects/meadow-hr/')).toBe('meadow-hr');
  });
});
