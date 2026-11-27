import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, promptHash, type ChatMessageDTO, type Settings } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db, MemoryService } from '../../src/core/contracts.js';
import { newId } from '../../src/core/ids.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createReplyRouter, type PromptEvent, type StopEvent } from '../../src/luady/replies.js';
import { createPresenceService } from '../../src/notices/presence.js';
import { createNoticeRouter } from '../../src/notices/router.js';
import { createNoticeState } from '../../src/notices/state.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { createFakeChat } from './fake-chat.js';

// 2026-11-14 in the test zone (UTC+4): 6:00 PM = 14:00Z.
const SIX_PM = '2026-11-14T14:00:00.000Z';
const NO_QUIET: Settings = { ...DEFAULT_SETTINGS, quiet_hours: { start: '00:00', end: '00:00', tz: 'Etc/GMT-4' } };

function memoryOf(db: Db): MemoryService {
  return {
    record: (msg) => {
      const dto: ChatMessageDTO = { id: newId(), thread: msg.thread, role: msg.role, channel: msg.channel, text: msg.text, ts: SIX_PM };
      db.prepare('INSERT INTO messages (id, thread, role, channel, text, ts, ext_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(dto.id, dto.thread, dto.role, dto.channel, dto.text, dto.ts, msg.extId ?? null);
      return dto;
    },
    search: () => [],
  };
}

const spool = (id: string, ts: string) => ({
  v: 1 as const, id, ts, host: 'hq', session_id: 'c-1', cwd: '/home/luady/brain', transcript_path: null, tmux: 'manager:0.0',
  permission_mode: 'dontAsk',
});
const promptOf = (text: string, ts: string): PromptEvent => ({
  ...spool(`p-${ts}`, ts), event: 'prompt', data: { prompt_sha256: promptHash(text), prompt_preview: text },
});
const stopOf = (id: string, ts: string, message: string): StopEvent => ({
  ...spool(id, ts), event: 'stop', data: { last_assistant_message: message, truncated: false },
});

/** One hub process: presence, the notice router and Luady's reply router on a shared database. */
function hub(db: Db, clock: ReturnType<typeof createFakeClock>) {
  const bus = createBus();
  const chat = createFakeChat();
  const state = createNoticeState(db);
  const presence = createPresenceService({ bus, clock, state, settings: { get: () => NO_QUIET } });
  const notices = createNoticeRouter({ db, bus, clock, log: silentLogger(), chat, presence, state, settings: { get: () => NO_QUIET } });
  const replies = createReplyRouter({ db, bus, clock, log: silentLogger(), memory: memoryOf(db), notices });
  presence.start();
  notices.start();
  const turn = async (text: string, channel: string, stopId: string, reply: string): Promise<void> => {
    const at = clock.now().toISOString();
    db.prepare('INSERT INTO injections (session_id, text_sha256, channel, created_at) VALUES (?, ?, ?, ?)')
      .run('hq:manager:0.0', promptHash(text), channel, at);
    if (channel === 'web' || channel === 'test-channel') db.prepare('UPDATE manager_state SET last_input_channel = ? WHERE id = 1').run(channel);
    if (channel === 'web') notices.webMessage(presence.sessionSaidHello('sid-owner')); // what POST /api/manager/messages does
    replies.onPrompt(promptOf(text, at));
    await replies.onStop(stopOf(stopId, at, reply), false);
  };
  const stop = (): void => {
    notices.stop();
    presence.stop();
  };
  return { chat, presence, notices, turn, stop, texts: () => chat.sent.map((s) => s.text) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('"a website client has said hello" survives a restart', () => {
  it('6:00 PM chat on the website, 6:30 PM restart, 7:00 PM a mission reply goes to the chat at once', async () => {
    const db = openMemoryDb();
    const clock = createFakeClock(SIX_PM);
    const before = hub(db, clock);
    before.presence.connect('tab-1', 'sid-owner');
    before.presence.hello('tab-1', true);
    before.presence.active('tab-1');
    await before.turn('[Web · Sat 18:00] deploy the fix please', 'web', 'stop-1', 'On it.');
    before.presence.disconnect('tab-1'); // the laptop is closed
    clock.advance(30 * 60_000);
    before.stop();
    const after = hub(db, clock); // 6:30 PM: the hub restarts
    expect(after.presence.capable()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(after.texts()).toEqual(['On it.']); // the unseen 6:00 PM website reply, overdue since 6:10, goes out once
    clock.advance(30 * 60_000);
    await after.turn('[Event · Sat 19:00] Your mission cedar · meadow-hr finished a turn after 600s.', 'event', 'stop-2', 'The fix is live.');
    expect(after.texts()).toEqual(['On it.', 'The fix is live.']);
    after.stop();
  });

  it('after the restart, a client present again gets the Event reply on the website first', async () => {
    const db = openMemoryDb();
    const clock = createFakeClock(SIX_PM);
    const before = hub(db, clock);
    before.presence.connect('tab-1', 'sid-owner');
    before.presence.hello('tab-1', true);
    before.stop();
    const after = hub(db, clock);
    after.presence.connect('tab-2', 'sid-owner');
    after.presence.hello('tab-2', true);
    after.presence.active('tab-2');
    await after.turn('[Event · Sat 18:00] Your mission finished.', 'event', 'stop-3', 'Done.');
    expect(after.texts()).toEqual([]);
    expect(after.notices.list()[0]).toMatchObject({ kind: 'result', chatSentAt: null, chatDueAt: '2026-11-14T14:10:00.000Z' });
    after.stop();
  });

  it('with the flag not set (a fresh database) an Event reply follows the last channel', async () => {
    const clock = createFakeClock(SIX_PM);
    const t = hub(openMemoryDb(), clock);
    expect(t.presence.capable()).toBe(false);
    await t.turn('[Web · Sat 18:00] status?', 'web', 'stop-4', 'All quiet.');
    await t.turn('[Event · Sat 18:01] Action A1 approved and done.', 'event', 'stop-5', 'A1 is done.');
    expect(t.texts()).toEqual([]);
    await t.turn('[Chat · Sat 18:02] and now?', 'test-channel', 'stop-6', 'Still quiet.');
    await t.turn('[Event · Sat 18:03] Action A2 approved and done.', 'event', 'stop-7', 'A2 is done.');
    expect(t.texts()).toEqual(['Still quiet.', 'A2 is done.']);
    t.stop();
  });

  it('the flag is a settings row the settings service ignores', () => {
    const db = openMemoryDb();
    const state = createNoticeState(db);
    expect(state.websiteFirst()).toBe(false);
    state.enableWebsiteFirst();
    state.enableWebsiteFirst();
    expect(createNoticeState(db).websiteFirst()).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'notices.website_first'").get()).toEqual({ n: 1 });
  });
});
