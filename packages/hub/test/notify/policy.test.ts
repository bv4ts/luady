import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@luady/shared';
import {
  BATCH_WINDOW_MS, allowedInQuietHours, canEscalate, escalationDueAt, isAlwaysSent, isBatchable,
  isDuplicateFailure, passesQuietHours, shouldHold, shouldNotifyFinished,
} from '../../src/notify/policy.js';

const QUIET = new Date('2026-10-09T21:00:00.000Z'); // 01:00 in owner time
const DAY = new Date('2026-10-09T12:00:00.000Z'); // 16:00 in owner time

describe('shouldNotifyFinished', () => {
  it('notifies long, remote or away turns and never a replay', () => {
    const base = { durationSec: 30, remote: false, away: false, replay: false, finishedMinSeconds: 120 };
    expect(shouldNotifyFinished(base)).toBe(false);
    expect(shouldNotifyFinished({ ...base, durationSec: 120 })).toBe(true);
    expect(shouldNotifyFinished({ ...base, remote: true })).toBe(true);
    expect(shouldNotifyFinished({ ...base, away: true })).toBe(true);
    expect(shouldNotifyFinished({ ...base, durationSec: 999, remote: true, away: true, replay: true })).toBe(false);
  });
});

describe('quiet hours', () => {
  it('always lets questions, permissions and confirmations through', () => {
    for (const kind of ['question', 'permission', 'confirmation'] as const) {
      expect(isAlwaysSent(kind)).toBe(true);
      expect(passesQuietHours(kind, false, QUIET, DEFAULT_SETTINGS)).toBe(true);
    }
  });

  it('suppresses finished, error and ended in quiet hours unless the turn was remote', () => {
    for (const kind of ['finished', 'error', 'ended'] as const) {
      expect(allowedInQuietHours(kind, false)).toBe(false);
      expect(passesQuietHours(kind, false, QUIET, DEFAULT_SETTINGS)).toBe(false);
      expect(passesQuietHours(kind, true, QUIET, DEFAULT_SETTINGS)).toBe(true);
      expect(passesQuietHours(kind, false, DAY, DEFAULT_SETTINGS)).toBe(true);
    }
  });
});

describe('canEscalate', () => {
  const ok = {
    pending: true, alreadyEscalated: false, phoneEnabledSetting: true, phoneAvailable: true, quiet: false, nightCalls: false,
  };

  it('needs a pending, unescalated question and an enabled, available phone', () => {
    expect(canEscalate(ok)).toBe(true);
    expect(canEscalate({ ...ok, pending: false })).toBe(false);
    expect(canEscalate({ ...ok, alreadyEscalated: true })).toBe(false);
    expect(canEscalate({ ...ok, phoneEnabledSetting: false })).toBe(false);
    expect(canEscalate({ ...ok, phoneAvailable: false })).toBe(false);
  });

  it('does not call in quiet hours unless night_calls is on', () => {
    expect(canEscalate({ ...ok, quiet: true })).toBe(false);
    expect(canEscalate({ ...ok, quiet: true, nightCalls: true })).toBe(true);
  });

  it('is due escalate_after_min after the question was created', () => {
    expect(escalationDueAt('2026-10-09T12:00:00.000Z', 10)).toBe(Date.parse('2026-10-09T12:10:00.000Z'));
  });
});

describe('batching and dedupe', () => {
  it('only batches finished, error and ended', () => {
    expect(isBatchable('finished')).toBe(true);
    expect(isBatchable('error')).toBe(true);
    expect(isBatchable('ended')).toBe(true);
    expect(isBatchable('question')).toBe(false);
    expect(isBatchable('confirmation')).toBe(false);
  });

  it('holds the fourth notification inside a 60 s window', () => {
    const now = 1_000_000;
    expect(shouldHold([now - 10_000, now - 5_000], now)).toBe(false);
    expect(shouldHold([now - 10_000, now - 5_000, now - 1_000], now)).toBe(true);
    expect(shouldHold([now - BATCH_WINDOW_MS, now - 5_000, now - 1_000], now)).toBe(false);
  });

  it('dedupes failures for 10 minutes', () => {
    expect(isDuplicateFailure(undefined, 0)).toBe(false);
    expect(isDuplicateFailure(0, 9 * 60_000)).toBe(true);
    expect(isDuplicateFailure(0, 10 * 60_000)).toBe(false);
  });
});
