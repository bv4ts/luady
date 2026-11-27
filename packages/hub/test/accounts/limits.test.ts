import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RateWindowDTO } from '@luady/shared';
import { NO_LIMITS_AFTER_READINGS, createLimitsStore, liveWindow } from '../../src/accounts/limits.js';
import { openDb, openMemoryDb } from '../../src/db/open.js';

const AT = '2026-11-14T10:00:00.000Z';
const RESET_5H = '2026-11-14T12:00:00.000Z';
const RESET_WEEK = '2026-11-17T05:00:00.000Z';
const win = (usedPct: number, resetsAt = RESET_5H): RateWindowDTO => ({ usedPct, resetsAt });
const NONE = { fiveHour: null, sevenDay: null };
const later = (minutes: number): string => new Date(Date.parse(AT) + minutes * 60_000).toISOString();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('limits store', () => {
  it('the first reading with windows is a change and shows reported yes', () => {
    const store = createLimitsStore(openMemoryDb());
    expect(store.record('cedar', { fiveHour: win(62.2), sevenDay: win(41, RESET_WEEK) }, AT)).toBe(true);
    expect(store.get('cedar')).toMatchObject({ host: 'cedar', reported: 'yes', fiveHour: win(62.2), sevenDay: win(41, RESET_WEEK), updatedAt: AT });
  });

  it('a change is a whole percent, a new reset time or a new reported state', () => {
    const store = createLimitsStore(openMemoryDb());
    store.record('cedar', { fiveHour: win(62.2), sevenDay: win(41, RESET_WEEK) }, AT);
    expect(store.record('cedar', { fiveHour: win(62.2), sevenDay: win(41, RESET_WEEK) }, later(1))).toBe(false);
    expect(store.record('cedar', { fiveHour: win(62.9), sevenDay: win(41, RESET_WEEK) }, later(2))).toBe(false);
    expect(store.record('cedar', { fiveHour: win(63.0), sevenDay: win(41, RESET_WEEK) }, later(3))).toBe(true);
    expect(store.record('cedar', { fiveHour: win(63.0, '2026-11-14T17:00:00.000Z'), sevenDay: win(41, RESET_WEEK) }, later(4))).toBe(true);
    expect(store.get('cedar')?.fiveHour).toEqual(win(63.0, '2026-11-14T17:00:00.000Z'));
  });

  it('a reading with only the weekly window keeps the stored 5-hour window', () => {
    const store = createLimitsStore(openMemoryDb());
    store.record('birch', { fiveHour: win(20), sevenDay: win(10, RESET_WEEK) }, AT);
    expect(store.record('birch', { fiveHour: null, sevenDay: win(12, RESET_WEEK) }, later(5))).toBe(true);
    expect(store.get('birch')).toMatchObject({ fiveHour: win(20), sevenDay: win(12, RESET_WEEK), fiveHourAt: AT, sevenDayAt: later(5) });
  });

  it('a missing window is unknown (null), never zero', () => {
    const store = createLimitsStore(openMemoryDb());
    store.record('ash', { fiveHour: null, sevenDay: win(5, RESET_WEEK) }, AT);
    expect(store.get('ash')).toMatchObject({ reported: 'yes', fiveHour: null, fiveHourAt: null });
  });

  it('four empty readings on a fresh host leave unknown; the fifth says the plan does not report limits', () => {
    const store = createLimitsStore(openMemoryDb());
    for (let i = 1; i < NO_LIMITS_AFTER_READINGS; i += 1) {
      expect(store.record('ash', NONE, later(i))).toBe(false);
      expect(store.get('ash')?.reported).toBe('unknown');
    }
    expect(store.record('ash', NONE, later(5))).toBe(true);
    expect(store.get('ash')).toMatchObject({ reported: 'no', fiveHour: null, sevenDay: null });
    expect(store.record('ash', NONE, later(6))).toBe(false);
    expect(store.record('ash', { fiveHour: win(3), sevenDay: null }, later(7))).toBe(true);
    expect(store.get('ash')?.reported).toBe('yes');
  });

  it('empty readings after a yes change nothing (the first reading of a session never has limits)', () => {
    const store = createLimitsStore(openMemoryDb());
    store.record('cedar', { fiveHour: win(50), sevenDay: win(30, RESET_WEEK) }, AT);
    for (let i = 1; i <= 10; i += 1) expect(store.record('cedar', NONE, later(i))).toBe(false);
    expect(store.get('cedar')).toMatchObject({ reported: 'yes', fiveHour: win(50), updatedAt: AT });
  });

  it('a reading older than the stored one (a replayed spool line) changes nothing', () => {
    const store = createLimitsStore(openMemoryDb());
    store.record('cedar', { fiveHour: win(70), sevenDay: win(41, RESET_WEEK) }, later(10));
    expect(store.record('cedar', { fiveHour: win(20), sevenDay: null }, later(5))).toBe(false);
    expect(store.get('cedar')).toMatchObject({ fiveHour: win(70), updatedAt: later(10) });
    const fresh = createLimitsStore(openMemoryDb());
    fresh.record('ash', NONE, later(10));
    fresh.record('ash', NONE, later(5));
    expect(fresh.get('ash')?.updatedAt).toBe(later(10));
  });

  it('all() lists every host with a reading; get() is undefined before one', () => {
    const store = createLimitsStore(openMemoryDb());
    expect(store.get('cedar')).toBeUndefined();
    store.record('cedar', { fiveHour: win(1), sevenDay: null }, AT);
    store.record('birch', NONE, AT);
    expect(store.all().map((limits) => limits.host).sort()).toEqual(['birch', 'cedar']);
  });

  it('survives reopening the database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'luady-limits-'));
    dirs.push(dir);
    const file = join(dir, 'hub.db');
    const first = openDb(file);
    createLimitsStore(first).record('cedar', { fiveHour: win(62), sevenDay: win(41, RESET_WEEK) }, AT);
    first.close();
    const second = openDb(file);
    expect(createLimitsStore(second).get('cedar')).toMatchObject({ reported: 'yes', fiveHour: win(62), sevenDay: win(41, RESET_WEEK) });
    second.close();
  });
});

describe('liveWindow', () => {
  it('is the window until its reset time, null one millisecond after it', () => {
    expect(liveWindow(win(62), new Date(RESET_5H))).toEqual(win(62));
    expect(liveWindow(win(62), new Date(Date.parse(RESET_5H) + 1))).toBeNull();
    expect(liveWindow(null, new Date(AT))).toBeNull();
  });
});

describe('limits follow the account, not the host', () => {
  it('reset drops what the host reported; a reading from before the reset is never merged back', () => {
    const store = createLimitsStore(openMemoryDb());
    store.record('cedar', { fiveHour: win(62), sevenDay: win(41, RESET_WEEK) }, AT);
    store.reset('cedar', later(10));
    expect(store.get('cedar')).toMatchObject({ reported: 'unknown', fiveHour: null, sevenDay: null, updatedAt: later(10) });
    expect(store.record('cedar', { fiveHour: win(80), sevenDay: null }, later(9))).toBe(false);
    expect(store.get('cedar')?.fiveHour).toBeNull();
    expect(store.record('cedar', { fiveHour: win(5), sevenDay: null }, later(11))).toBe(true);
    expect(store.get('cedar')).toMatchObject({ reported: 'yes', fiveHour: win(5), sevenDay: null });
  });

  it('a reset host counts empty readings toward "does not report" from zero again', () => {
    const store = createLimitsStore(openMemoryDb());
    for (let i = 1; i <= NO_LIMITS_AFTER_READINGS; i += 1) store.record('ash', NONE, later(i));
    expect(store.get('ash')?.reported).toBe('no');
    store.reset('ash', later(10));
    expect(store.get('ash')?.reported).toBe('unknown');
    store.record('ash', NONE, later(11));
    expect(store.get('ash')?.reported).toBe('unknown');
  });
});

describe('a replayed reading', () => {
  it('the same empty reading replayed five times counts once towards "does not report"', () => {
    const store = createLimitsStore(openMemoryDb());
    for (let i = 0; i < NO_LIMITS_AFTER_READINGS; i += 1) expect(store.record('birch', NONE, AT)).toBe(false);
    expect(store.get('birch')?.reported).toBe('unknown');
    for (let i = 1; i < NO_LIMITS_AFTER_READINGS; i += 1) store.record('birch', NONE, later(i));
    expect(store.get('birch')?.reported).toBe('no');
  });
});
