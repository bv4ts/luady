import { DEFAULT_SETTINGS } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { qrMatrix } from '../../../src/features/channels/qr.js';
import { diffSettings, readNumber, validateSettings } from '../../../src/features/settings/settings-form.js';

describe('settings form helpers', () => {
  it('diffs only the changed fields', () => {
    const next = { ...DEFAULT_SETTINGS, escalate_after_min: 15, quiet_hours: { ...DEFAULT_SETTINGS.quiet_hours, start: '23:00' } };
    expect(diffSettings(DEFAULT_SETTINGS, next)).toEqual({
      escalate_after_min: 15, quiet_hours: { start: '23:00', end: '08:00' },
    });
    expect(diffSettings(DEFAULT_SETTINGS, DEFAULT_SETTINGS)).toEqual({});
  });

  it('turns schema issues into friendly field errors', () => {
    const errors = validateSettings({
      ...DEFAULT_SETTINGS, escalate_after_min: 0, call_rate_per_hour: Number.NaN,
      quiet_hours: { ...DEFAULT_SETTINGS.quiet_hours, end: '25:00' },
    });
    expect(errors).toEqual({
      escalate_after_min: 'Use a whole number from 1 to 240.',
      call_rate_per_hour: 'Use a whole number from 0 to 10.',
      'quiet_hours.end': 'Use a 24-hour time like 07:00.',
    });
    expect(validateSettings(DEFAULT_SETTINGS)).toEqual({});
  });

  it('reads an empty number input as invalid', () => {
    expect(Number.isNaN(readNumber(''))).toBe(true);
    expect(readNumber(' 12 ')).toBe(12);
  });

  it('builds a square QR matrix with finder patterns', () => {
    const matrix = qrMatrix('2@abcdefghijklmnopqrstuvwxyz0123456789,luady');
    expect(matrix.length).toBeGreaterThanOrEqual(21);
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
    expect(matrix[0]?.slice(0, 7)).toEqual([true, true, true, true, true, true, true]);
  });
});
