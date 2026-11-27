import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, LIMITS, type PresenceDTO, type Settings } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createPresenceService, isFresh, PRESENCE_PING_MS, PRESENCE_TICK_MS } from '../../src/notices/presence.js';
import { createNoticeState } from '../../src/notices/state.js';
import { createFakeClock } from '../helpers/fakes.js';

const SIX_PM = '2026-11-14T14:00:00.000Z'; // 6:00 PM in owner time
const MINUTE = 60_000;
const PING_MS = 25_000;

function setup(opts: { db?: Db; start?: string } = {}) {
  const db = opts.db ?? openMemoryDb();
  const clock = createFakeClock(opts.start ?? SIX_PM);
  const bus = createBus();
  let settings: Settings = DEFAULT_SETTINGS;
  const events: PresenceDTO[] = [];
  bus.on('presence.updated', (state) => events.push(state));
  const presence = createPresenceService({ bus, clock, state: createNoticeState(db), settings: { get: () => settings } });
  presence.start();
  const pinging = new Set<string>();
  /** Moves the clock and the timers together; every client in `pinging` pings every 25 seconds, like the website. */
  const pass = (ms: number): void => {
    for (let left = ms; left > 0; left -= Math.min(left, 5_000)) {
      const step = Math.min(left, 5_000);
      clock.advance(step);
      vi.advanceTimersByTime(step);
      if (clock.now().getTime() % PING_MS < step) for (const id of pinging) presence.seen(id);
    }
  };
  const open = (id: string, sid = 'sid-pc', visible = true): void => {
    presence.connect(id, sid);
    presence.hello(id, visible);
    pinging.add(id);
  };
  const setAway = (away: boolean): void => {
    settings = { ...settings, away };
    bus.emit('settings.updated', settings);
  };
  return { db, clock, bus, presence, events, pass, open, pinging, setAway };
}

const at = (minutes: number): string => new Date(Date.parse(SIX_PM) + minutes * MINUTE).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('presence', () => {
  it('starts away and not capable; a socket that never says hello changes nothing', () => {
    const t = setup();
    expect(t.presence.state()).toEqual({ mode: 'chat', online: false, clients: 0, forcedUntil: null });
    expect(t.presence.capable()).toBe(false);
    t.presence.connect('c1', 'sid-pc');
    expect(t.presence.state()).toEqual({ mode: 'chat', online: false, clients: 0, forcedUntil: null });
    expect(t.events).toEqual([]);
    t.presence.stop();
  });

  it('a hello alone is not presence; the first presence.active is, and it is published once', () => {
    const t = setup();
    t.open('c1');
    expect(t.presence.capable()).toBe(true);
    expect(t.presence.state()).toEqual({ mode: 'chat', online: false, clients: 1, forcedUntil: null });
    t.presence.active('c1');
    expect(t.presence.state()).toEqual({ mode: 'here', online: true, clients: 1, forcedUntil: null });
    expect(t.events).toEqual([{ mode: 'here', online: true, clients: 1, forcedUntil: null }]);
    t.presence.stop();
  });

  it('a VISIBLE tab nobody touched since 6:00 PM is away at 6:30 PM', () => {
    const t = setup();
    t.open('c1', 'sid-pc', true);
    t.presence.active('c1');
    t.pass(29 * MINUTE);
    expect(t.presence.state().mode).toBe('here');
    t.pass(MINUTE);
    expect(t.presence.state()).toMatchObject({ mode: 'chat', online: false });
    expect(t.events.at(-1)).toMatchObject({ mode: 'chat', online: false });
    t.presence.stop();
  });

  it('activity at 6:29 PM restarts the 30 minutes', () => {
    const t = setup();
    t.open('c1');
    t.presence.active('c1');
    t.pass(29 * MINUTE);
    t.presence.active('c1');
    t.pass(29 * MINUTE);
    expect(t.presence.state().online).toBe(true);
    t.pass(MINUTE);
    expect(t.presence.state().online).toBe(false);
    t.presence.stop();
  });

  it('6:00 PM active, 6:20 PM the tab reconnects and says hello again: still away at 6:30 PM', () => {
    const t = setup();
    t.open('tab-1');
    t.presence.active('tab-1');
    t.pass(20 * MINUTE);
    t.presence.disconnect('tab-1');
    t.pinging.delete('tab-1');
    t.open('tab-1-again', 'sid-pc', true);
    expect(t.presence.state().online).toBe(true);
    t.pass(10 * MINUTE);
    expect(t.presence.state().online).toBe(false);
    t.presence.stop();
  });

  it('only a client whose last hello said visible may acknowledge', () => {
    const t = setup();
    t.open('hidden', 'sid-pc', false);
    t.open('visible', 'sid-phone', true);
    expect(t.presence.canAck('hidden')).toBe(false);
    expect(t.presence.canAck('visible')).toBe(true);
    t.presence.hello('visible', false);
    expect(t.presence.canAck('visible')).toBe(false);
    expect(t.presence.canAck('unknown')).toBe(false);
    t.presence.stop();
  });

  it('a hidden tab whose browser slows its pings to one a minute (or a little slower) stays online', () => {
    const t = setup();
    t.open('c1');
    t.presence.active('c1');
    t.pinging.delete('c1');
    for (let minute = 0; minute < 5; minute += 1) {
      t.pass(70_000);
      t.presence.seen('c1');
    }
    expect(t.presence.state().online).toBe(true);
    expect(PRESENCE_PING_MS).toBe(180_000);
    t.presence.stop();
  });

  it('6:00 PM active, pings stop at 6:01 PM: dropped 180 seconds after the last ping', () => {
    const t = setup();
    t.open('c1');
    t.presence.active('c1');
    t.pass(MINUTE);
    expect(t.presence.state().online).toBe(true);
    t.pinging.delete('c1');
    t.pass(PRESENCE_PING_MS + PING_MS);
    expect(t.presence.state()).toEqual({ mode: 'chat', online: false, clients: 0, forcedUntil: null });
    expect(t.presence.canAck('c1')).toBe(false);
    t.presence.stop();
  });

  it('"Updates: chat" pressed at 6:00 PM survives a 6:30 PM restart and ends at 7:00 PM', () => {
    const db = openMemoryDb();
    const before = setup({ db });
    expect(before.presence.force(true)).toMatchObject({ mode: 'chat', forcedUntil: at(60) });
    before.presence.stop();
    const after = setup({ db, start: at(30) });
    expect(after.presence.forced()).toBe(true);
    after.open('c1');
    after.presence.active('c1');
    expect(after.presence.state()).toEqual({ mode: 'chat', online: true, clients: 1, forcedUntil: at(60) });
    after.pass(20 * MINUTE);
    after.presence.active('c1');
    after.pass(10 * MINUTE);
    expect(after.presence.forced()).toBe(false);
    expect(after.events.at(-1)).toEqual({ mode: 'here', online: true, clients: 1, forcedUntil: null });
    expect(after.presence.force(false).forcedUntil).toBeNull();
    expect(LIMITS.presenceForceMs).toBe(60 * MINUTE);
    after.presence.stop();
  });

  it('/away forces the chat while it is on, even with an active visible tab', () => {
    const t = setup();
    t.open('c1');
    t.presence.active('c1');
    t.setAway(true);
    expect(t.presence.forced()).toBe(true);
    expect(t.presence.state()).toMatchObject({ mode: 'chat', online: true });
    expect(t.events.at(-1)).toMatchObject({ mode: 'chat' });
    t.setAway(false);
    expect(t.presence.state().mode).toBe('here');
    t.presence.stop();
  });

  it('a tab that reconnects ten times in a minute while another stays active emits nothing', () => {
    const t = setup();
    t.open('c1');
    t.presence.active('c1');
    const before = t.events.length;
    for (let i = 0; i < 10; i += 1) {
      t.open(`flaky-${i}`, 'sid-other');
      t.presence.disconnect(`flaky-${i}`);
      t.pinging.delete(`flaky-${i}`);
    }
    expect(t.events).toHaveLength(before);
    t.presence.stop();
  });

  it('isFresh: touched less than 30 minutes ago, visible or not; never touched is not fresh', () => {
    const now = Date.parse(SIX_PM);
    expect(isFresh({ touchedAt: now - 30 * MINUTE + 1 }, now)).toBe(true);
    expect(isFresh({ touchedAt: now - 30 * MINUTE }, now)).toBe(false);
    expect(isFresh({ touchedAt: null }, now)).toBe(false);
    expect(PRESENCE_TICK_MS).toBeLessThanOrEqual(PRESENCE_PING_MS);
  });

  it('stop() ends the tick', () => {
    const t = setup();
    t.open('c1');
    t.presence.active('c1');
    t.presence.stop();
    t.pinging.clear();
    t.pass(31 * MINUTE);
    expect(t.events).toHaveLength(1);
  });
});
