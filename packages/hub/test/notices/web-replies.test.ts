import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createPresenceService } from '../../src/notices/presence.js';
import { createNoticeRouter } from '../../src/notices/router.js';
import { createNoticeState } from '../../src/notices/state.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { createFakeChat } from './fake-chat.js';

const SIX_PM = '2026-11-14T14:00:00.000Z'; // 6:00 PM in owner time
const MINUTE = 60_000;
const NO_QUIET: Settings = { ...DEFAULT_SETTINGS, quiet_hours: { start: '00:00', end: '00:00', tz: 'Etc/GMT-4' } };

function setup() {
  const db = openMemoryDb();
  const clock = createFakeClock(SIX_PM);
  const bus = createBus();
  const chat = createFakeChat();
  const state = createNoticeState(db);
  const presence = createPresenceService({ bus, clock, state, settings: { get: () => NO_QUIET } });
  const router = createNoticeRouter({ db, bus, clock, log: silentLogger(), chat, presence, state, settings: { get: () => NO_QUIET } });
  presence.start();
  router.start();
  const pass = async (ms: number): Promise<void> => {
    for (let left = ms; left > 0; left -= Math.min(left, 5_000)) {
      clock.advance(Math.min(left, 5_000));
      await vi.advanceTimersByTimeAsync(Math.min(left, 5_000));
    }
  };
  const reply = (text: string) => router.post({ kind: 'reply', source: 'web', text, ref: { kind: 'manager', id: `m-${text}` } });
  const stop = (): void => {
    router.stop();
    presence.stop();
  };
  return { db, clock, chat, presence, router, state, pass, reply, stop, texts: () => chat.sent.map((s) => s.text) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hello is per client, and the next website message settles open chat replies', () => {
  it('6:00 PM the phone says hello; 6:05 PM eight replies to a PC tab on the old website stay in the chat, no chat copies', async () => {
    const t = setup();
    t.presence.connect('phone-tab', 'sid-phone');
    t.presence.hello('phone-tab', true);
    t.presence.active('phone-tab');
    await t.pass(5 * MINUTE);
    t.router.webMessage(t.presence.sessionSaidHello('sid-pc'));
    for (let i = 1; i <= 8; i += 1) await t.reply(`reply ${i}`);
    expect(t.router.list().filter((n) => n.kind === 'reply').every((n) => n.chatDueAt === null)).toBe(true);
    await t.pass(30 * MINUTE);
    expect(t.chat.sent).toEqual([]);
    t.stop();
  });

  it('a reply to a tab that said hello waits on the website and falls back at minute 10 when nothing follows', async () => {
    const t = setup();
    t.presence.connect('pc-tab', 'sid-pc');
    t.presence.hello('pc-tab', true);
    t.presence.active('pc-tab');
    t.router.webMessage(t.presence.sessionSaidHello('sid-pc'));
    await t.reply('Here is the plan.');
    await t.pass(10 * MINUTE);
    expect(t.texts()).toEqual(['Here is the plan.']);
    t.stop();
  });

  it('6:00 PM reply in a hello tab, 6:08 PM the owner writes again on the website: the reply settles, nothing at 6:10', async () => {
    const t = setup();
    t.presence.connect('pc-tab', 'sid-pc');
    t.presence.hello('pc-tab', true);
    t.presence.active('pc-tab');
    t.router.webMessage(true);
    const first = await t.reply('Here is the plan.');
    await t.pass(8 * MINUTE);
    t.router.webMessage(true);
    expect(t.router.list().find((n) => n.id === first.notice?.id)).toMatchObject({ settledVia: 'web' });
    await t.pass(10 * MINUTE);
    expect(t.chat.sent).toEqual([]);
    t.stop();
  });

  it('a tool message during a turn from an old website tab goes to the chat at once', async () => {
    const t = setup();
    t.presence.connect('phone-tab', 'sid-phone');
    t.presence.hello('phone-tab', true);
    t.presence.active('phone-tab');
    t.router.webMessage(false);
    await expect(t.router.post({ kind: 'result', source: 'web', text: 'Deployed.', ref: null })).resolves.toMatchObject({ msgId: 'fake-wa-1' });
    t.stop();
  });

  it('which tab wrote last is remembered across a restart', () => {
    const t = setup();
    t.router.webMessage(true);
    expect(createNoticeState(t.db).webTabHello()).toBe(true);
    t.router.webMessage(false);
    expect(createNoticeState(t.db).webTabHello()).toBe(false);
    t.stop();
  });

  it('sessionSaidHello is per signed-in session', () => {
    const t = setup();
    t.presence.connect('a', 'sid-1');
    t.presence.connect('b', 'sid-2');
    t.presence.hello('a', false);
    expect(t.presence.sessionSaidHello('sid-1')).toBe(true);
    expect(t.presence.sessionSaidHello('sid-2')).toBe(false);
    expect(t.presence.sessionSaidHello('sid-unknown')).toBe(false);
    t.stop();
  });
});
