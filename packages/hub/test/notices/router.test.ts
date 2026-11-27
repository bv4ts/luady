import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type NoticeDTO, type NoticeRef, type PresenceDTO, type Settings } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db, HubEvents } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createNoticeRouter, NOTICE_TICK_MS, type NoticeRouter } from '../../src/notices/router.js';
import { sampleAction, sampleQuestion } from '../web/helpers.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { createFakeChat } from './fake-chat.js';

const T0 = '2026-11-14T10:00:00.000Z'; // 2:00 PM in owner time
const MINUTE = 60_000;
const NO_QUIET: Settings = { ...DEFAULT_SETTINGS, quiet_hours: { start: '00:00', end: '00:00', tz: 'Etc/GMT-4' } };

interface PresenceStub { mode: PresenceDTO['mode']; forced: boolean; capable: boolean; forcedUntil: string | null }

function setup(opts: {
  presence?: Partial<PresenceStub>; settings?: Settings; db?: Db; start?: string; clock?: ReturnType<typeof createFakeClock>;
  refState?: (ref: NoticeRef) => 'open' | 'closed' | 'unknown';
} = {}) {
  const db = opts.db ?? openMemoryDb();
  const clock = opts.clock ?? createFakeClock(opts.start ?? T0);
  const bus = createBus();
  const chat = createFakeChat();
  const stub: PresenceStub = { mode: 'here', forced: false, capable: true, forcedUntil: null, ...opts.presence };
  const presence = {
    state: (): PresenceDTO => ({ mode: stub.mode, online: stub.mode === 'here', clients: 1, forcedUntil: stub.forcedUntil }),
    forced: () => stub.forced,
    capable: () => stub.capable,
  };
  const created: NoticeDTO[] = [];
  const updated: NoticeDTO[] = [];
  const delivered: Array<HubEvents['notice.delivered']> = [];
  bus.on('notice.created', (n) => created.push(n));
  bus.on('notice.updated', (n) => updated.push(n));
  bus.on('notice.delivered', (d) => delivered.push(d));
  const settings = opts.settings ?? NO_QUIET;
  const router = createNoticeRouter({ state: { webTabHello: () => true, setWebTabHello: () => undefined }, db, bus, clock, log: silentLogger(), chat, presence, settings: { get: () => settings }, ...(opts.refState === undefined ? {} : { refState: opts.refState }) });
  /** Moves the fake clock and the fake timers together, in tick-sized steps. */
  const pass = async (ms: number): Promise<void> => {
    for (let left = ms; left > 0; left -= Math.min(left, NOTICE_TICK_MS)) {
      const step = Math.min(left, NOTICE_TICK_MS);
      clock.advance(step);
      await vi.advanceTimersByTimeAsync(step);
    }
  };
  const texts = (): string[] => chat.sent.map((s) => s.text);
  return { db, clock, bus, chat, stub, router, created, updated, delivered, pass, texts };
}

type Harness = ReturnType<typeof setup>;
const routers: NoticeRouter[] = [];

function started(t: Harness): Harness {
  t.router.start();
  routers.push(t.router);
  return t;
}

const iso = (base: string, ms: number): string => new Date(Date.parse(base) + ms).toISOString();
const result = (text = 'Mission done: login fixed') => ({ kind: 'result' as const, source: 'hub' as const, text, ref: { kind: 'session' as const, id: 'cedar:cc-a:0.0' } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  for (const router of routers.splice(0)) router.stop();
  vi.useRealTimers();
});

describe('notice router: website first, the chat after ten minutes', () => {
  it('holds a hub update on the website and sends the same text once at minute 10', async () => {
    const t = started(setup());
    const posted = await t.router.post(result());
    expect(posted.msgId).toBeNull();
    expect(t.chat.sent).toEqual([]);
    expect(t.created).toEqual([expect.objectContaining({ kind: 'result', chatDueAt: iso(T0, 10 * MINUTE), chatSentAt: null, settledAt: null })]);
    await t.pass(10 * MINUTE - 1_000);
    expect(t.chat.sent).toEqual([]);
    await t.pass(1_000);
    expect(t.chat.sent).toEqual([{ text: 'Mission done: login fixed', link: { kind: 'session', refId: 'cedar:cc-a:0.0' }, quotedId: null }]);
    expect(t.updated.at(-1)).toMatchObject({ chatSentAt: iso(T0, 10 * MINUTE), settledVia: 'test-channel' });
    expect(t.delivered).toEqual([{ notice: expect.objectContaining({ id: posted.notice?.id }), msgId: 'fake-wa-1' }]);
    await t.pass(5 * MINUTE);
    await t.router.tick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.chat.sent).toHaveLength(1);
  });

  it('a notice seen on the website at minute 3 never reaches the chat', async () => {
    const t = started(setup());
    const posted = await t.router.post(result());
    await t.pass(3 * MINUTE);
    t.router.ack([posted.notice?.id ?? '']);
    expect(t.updated.at(-1)).toMatchObject({ id: posted.notice?.id, settledVia: 'web' });
    await t.pass(10 * MINUTE);
    expect(t.chat.sent).toEqual([]);
    expect(t.delivered).toEqual([]);
  });

  it('a question is not settled by being seen, only by its answer; answered at minute 9 means no chat message at minute 10', async () => {
    const t = started(setup());
    const posted = await t.router.post({ kind: 'question', source: 'hub', text: '🔴 Which DB?', ref: { kind: 'question', id: 'ABCDEFGH' } });
    t.router.ack([posted.notice?.id ?? '']);
    expect(t.router.list()[0]?.settledAt).toBeNull();
    await t.pass(9 * MINUTE);
    t.bus.emit('question.updated', sampleQuestion({ qid: 'ABCDEFGH', state: 'answered' }));
    expect(t.updated.at(-1)).toMatchObject({ id: posted.notice?.id, settledVia: 'answer' });
    await t.pass(5 * MINUTE);
    expect(t.chat.sent).toEqual([]);
  });

  it('a question whose fallback fired stays open until it is answered', async () => {
    const t = started(setup());
    const posted = await t.router.post({ kind: 'question', source: 'hub', text: '🔴 Which DB?', ref: { kind: 'question', id: 'ABCDEFGH' } });
    await t.pass(10 * MINUTE);
    expect(t.texts()).toEqual(['🔴 Which DB?']);
    expect(t.router.list()[0]).toMatchObject({ id: posted.notice?.id, chatSentAt: iso(T0, 10 * MINUTE), settledAt: null });
    t.bus.emit('question.updated', sampleQuestion({ qid: 'ABCDEFGH', state: 'answered' }));
    expect(t.router.list()[0]).toMatchObject({ settledVia: 'answer' });
    expect(t.chat.sent).toHaveLength(1);
  });

  it('a red question listed by /q at minute 2 is not sent again by the fallback at minute 10', async () => {
    const t = started(setup());
    const posted = await t.router.post({ kind: 'question', source: 'hub', text: '🔴 Which DB?', ref: { kind: 'question', id: 'ABCDEFGH' } });
    await t.pass(2 * MINUTE);
    t.router.sentElsewhere('question', 'ABCDEFGH', 'wamid.Q');
    expect(t.updated.at(-1)).toMatchObject({ id: posted.notice?.id, chatSentAt: iso(T0, 2 * MINUTE), settledAt: null });
    await t.pass(15 * MINUTE);
    expect(t.chat.sent).toEqual([]);
    expect(t.delivered).toEqual([]);
  });

  it('a question answered at the terminal while the hub was down (4:05 PM) is settled at the 4:30 PM restart, never sent', async () => {
    const db = openMemoryDb();
    await setup({ db }).router.post({ kind: 'question', source: 'hub', text: '🔴 Which DB?', ref: { kind: 'question', id: 'ABCDEFGH' } });
    const t = started(setup({ db, start: iso(T0, 30 * MINUTE), refState: () => 'closed' }));
    await t.pass(5_000);
    expect(t.chat.sent).toEqual([]);
    expect(t.router.list()[0]).toMatchObject({ settledVia: 'answer' });
    expect(t.updated.at(-1)).toMatchObject({ settledVia: 'answer' });
  });

  it('a question whose server has not reported in since the restart waits; once it has and the question is open, it goes', async () => {
    const db = openMemoryDb();
    await setup({ db }).router.post({ kind: 'question', source: 'hub', text: '🔴 Which DB?', ref: { kind: 'question', id: 'ABCDEFGH' } });
    let state: 'unknown' | 'open' = 'unknown';
    const t = started(setup({ db, start: iso(T0, 30 * MINUTE), refState: () => state }));
    await t.pass(MINUTE);
    expect(t.chat.sent).toEqual([]);
    state = 'open';
    await t.pass(5_000);
    expect(t.texts()).toEqual(['🔴 Which DB?']);
  });

  it('a backlog checks each question too: answered ones are settled and left out', async () => {
    const db = openMemoryDb();
    const before = setup({ db });
    for (const id of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5']) {
      await before.router.post({ kind: 'question', source: 'hub', text: `🔴 #${id}`, ref: { kind: 'question', id } });
    }
    const answered = new Set(['Q2', 'Q4']);
    const t = started(setup({ db, start: iso(T0, 30 * MINUTE), refState: (ref) => (answered.has(ref.id) ? 'closed' : 'open') }));
    await t.pass(15_000);
    expect(t.texts().join('|')).not.toMatch(/#Q2|#Q4/);
    expect(t.router.list().filter((n) => n.settledVia === 'answer').map((n) => n.text).sort()).toEqual(['🔴 #Q2', '🔴 #Q4']);
  });

  it('a confirmation leaving pending_confirmation settles its permission notice', async () => {
    const t = started(setup());
    await t.router.post({ kind: 'permission', source: 'hub', text: 'Confirm A7', ref: { kind: 'action', id: 'A7' } });
    t.bus.emit('action.updated', sampleAction({ id: 'A7', status: 'pending_confirmation' }));
    expect(t.router.list()[0]?.settledAt).toBeNull();
    t.bus.emit('action.updated', sampleAction({ id: 'A7', status: 'denied' }));
    expect(t.router.list()[0]?.settledVia).toBe('answer');
    await t.pass(11 * MINUTE);
    expect(t.chat.sent).toEqual([]);
  });

  it('list() puts open notices first', async () => {
    const t = setup();
    const first = await t.router.post(result('first'));
    t.clock.advance(MINUTE);
    const second = await t.router.post(result('second'));
    t.router.ack([second.notice?.id ?? '']);
    expect(t.router.list().map((n) => n.id)).toEqual([first.notice?.id, second.notice?.id]);
  });
});

describe('notice router: the chat at once', () => {
  it('while away an update goes to the chat at once, is stored and settled, with no due time', async () => {
    const t = setup({ presence: { mode: 'chat' } });
    const posted = await t.router.post(result());
    expect(posted.msgId).toBe('fake-wa-1');
    expect(t.texts()).toEqual(['Mission done: login fixed']);
    expect(posted.notice).toMatchObject({ chatDueAt: null, chatSentAt: T0, settledAt: T0, settledVia: 'test-channel' });
    expect(t.created).toHaveLength(1);
  });

  it('a red question sent at once stays open until answered', async () => {
    const t = setup({ presence: { mode: 'chat' } });
    const posted = await t.router.post({ kind: 'question', source: 'hub', text: '🔴 Which DB?', ref: { kind: 'question', id: 'Q1' } });
    expect(posted.notice).toMatchObject({ chatSentAt: T0, settledAt: null });
  });

  it('a reply to a chat message goes back at once with its quote and is not stored', async () => {
    const t = setup();
    const posted = await t.router.post({ kind: 'reply', source: 'chat', text: 'birch is idle', ref: { kind: 'manager', id: 'm1' }, quotedId: 'in-1' });
    expect(posted).toEqual({ notice: null, msgId: 'fake-wa-1' });
    expect(t.chat.sent).toEqual([{ text: 'birch is idle', link: { kind: 'manager', refId: 'm1' }, quotedId: 'in-1' }]);
    expect(t.created).toEqual([]);
    expect(t.router.list()).toEqual([]);
  });

  it('the morning message goes to the chat at once even with the website on, and is stored', async () => {
    const t = setup();
    const posted = await t.router.post({ kind: 'morning', source: 'web', text: 'Good morning', ref: { kind: 'manager', id: 'm2' } });
    expect(posted.msgId).toBe('fake-wa-1');
    expect(posted.notice).toMatchObject({ kind: 'morning', chatSentAt: T0, settledVia: 'test-channel' });
  });

  it('while forced, an update goes to the chat at once', async () => {
    const t = setup({ presence: { forced: true } });
    expect((await t.router.post(result())).msgId).toBe('fake-wa-1');
    expect(t.router.wouldSendNow('result', 'hub')).toBe(true);
  });

  it('cuts the stored text at 8000 characters while the chat gets the whole text', async () => {
    const t = setup({ presence: { mode: 'chat' } });
    const long = 'x'.repeat(9_000);
    const posted = await t.router.post(result(long));
    expect(t.texts()).toEqual([long]);
    expect(posted.notice?.text).toHaveLength(8_000);
    expect(posted.notice?.text.endsWith('…')).toBe(true);
  });

  it('a second post for an open question does not create a second notice or a second message', async () => {
    const t = setup({ presence: { mode: 'chat' } });
    const question = { kind: 'question' as const, source: 'hub' as const, text: '🔴 Which DB?', ref: { kind: 'question' as const, id: 'Q1' } };
    const first = await t.router.post(question);
    const again = await t.router.post(question);
    expect(again).toEqual({ notice: first.notice, msgId: null });
    expect(t.chat.sent).toHaveLength(1);
    expect(t.created).toHaveLength(1);
  });
});

describe('notice router: before any new website client said hello', () => {
  it('a website reply stays in the website chat with no fallback, and never reaches the chat', async () => {
    const t = started(setup({ presence: { mode: 'chat', capable: false } }));
    const posted = await t.router.post({ kind: 'reply', source: 'web', text: 'Answered on the web', ref: { kind: 'manager', id: 'm1' } });
    expect(posted.msgId).toBeNull();
    expect(posted.notice).toMatchObject({ chatDueAt: null, settledAt: null });
    await t.pass(30 * MINUTE);
    expect(t.chat.sent).toEqual([]);
  });

  it('anything else from a website turn (notify_user) goes to the chat at once', async () => {
    const t = setup({ presence: { mode: 'chat', capable: false } });
    const posted = await t.router.post({ kind: 'result', source: 'web', text: 'Deployed', ref: null });
    expect(posted.msgId).toBe('fake-wa-1');
    expect(t.router.wouldSendNow('result', 'web')).toBe(true);
    expect(t.router.wouldSendNow('result', 'hub')).toBe(true);
  });
});

describe('notice router: forcing the chat, restarts and the throttle', () => {
  it('pressing "Updates: chat" sends every pending notice, 3 seconds apart, in creation order', async () => {
    const t = started(setup());
    for (const text of ['one', 'two', 'three']) {
      await t.router.post(result(text));
      t.clock.advance(1_000);
    }
    t.stub.forced = true;
    t.bus.emit('presence.updated', { mode: 'chat', online: true, clients: 1, forcedUntil: iso(T0, 60 * MINUTE) });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.texts()).toEqual(['one']);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(t.texts()).toEqual(['one']);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.texts()).toEqual(['one', 'two']);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.texts()).toEqual(['one', 'two', 'three']);
    await t.pass(20 * MINUTE);
    expect(t.texts()).toEqual(['one', 'two', 'three']);
  });

  it('/away switched on at 2:05 PM with a tab online sends what is pending at once', async () => {
    const t = started(setup());
    await t.router.post(result('pending since 2:00'));
    await t.pass(5 * MINUTE);
    t.stub.forced = true;
    t.bus.emit('presence.updated', { mode: 'chat', online: true, clients: 1, forcedUntil: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.texts()).toEqual(['pending since 2:00']);
  });

  it('presence flapping (a tab reconnecting ten times, a forgotten tab going stale) neither creates nor resends anything', async () => {
    const t = started(setup());
    await t.router.post(result('pending'));
    await t.pass(10 * MINUTE);
    expect(t.texts()).toEqual(['pending']);
    for (let i = 0; i < 10; i += 1) {
      t.stub.mode = i % 2 === 0 ? 'chat' : 'here';
      t.bus.emit('presence.updated', { mode: t.stub.mode, online: t.stub.mode === 'here', clients: 1, forcedUntil: null });
    }
    await t.pass(5 * MINUTE);
    expect(t.texts()).toEqual(['pending']);
    expect(t.created).toHaveLength(1);
  });

  it('after a restart, overdue notices go out once each, 3 seconds apart, even while ticks keep coming', async () => {
    const db = openMemoryDb();
    const before = setup({ db });
    for (const text of ['a', 'b', 'c']) await before.router.post(result(text));
    const after = started(setup({ db, start: iso(T0, 45 * MINUTE) }));
    await vi.advanceTimersByTimeAsync(0);
    expect(after.texts()).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(after.texts()).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(after.texts()).toEqual(['a', 'b', 'c']);
    expect(before.chat.sent).toEqual([]);
  });

  it('a restart in the middle of a backlog sends the rest after the restart and nothing twice', async () => {
    const db = openMemoryDb();
    const clock = createFakeClock(iso(T0, 45 * MINUTE));
    const before = setup({ db });
    for (const text of ['a', 'b', 'c']) await before.router.post(result(text));
    const first = setup({ db, clock });
    first.router.start();
    await vi.advanceTimersByTimeAsync(0);
    first.router.stop();
    const second = started(setup({ db, clock }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(first.texts()).toEqual(['a']);
    expect(second.texts()).toEqual(['b', 'c']);
  });

  it('two routers ticking at the same moment send an overdue notice once in total', async () => {
    const db = openMemoryDb();
    await setup({ db }).router.post(result('only once'));
    const later = createFakeClock(iso(T0, 11 * MINUTE));
    const a = setup({ db, clock: later });
    const b = setup({ db, clock: later });
    await Promise.all([a.router.tick(), b.router.tick()]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect([...a.texts(), ...b.texts()]).toEqual(['only once']);
  });
});

describe('notice router: quiet hours and a link that is down', () => {
  it('a result due at 00:05 owner time waits for 08:00, a question due then goes at once', async () => {
    const night = '2026-11-13T19:55:00.000Z'; // 11:55 PM in owner time
    const t = started(setup({ start: night, settings: DEFAULT_SETTINGS }));
    await t.router.post(result('night result'));
    await t.router.post({ kind: 'question', source: 'hub', text: '🔴 night question', ref: { kind: 'question', id: 'Q9' } });
    await t.pass(10 * MINUTE);
    expect(t.texts()).toEqual(['🔴 night question']);
    expect(t.router.list().find((n) => n.text === 'night result')?.chatDueAt).toBe('2026-11-14T04:00:00.000Z');
    await t.pass(7 * 60 * MINUTE + 50 * MINUTE);
    expect(t.texts()).toEqual(['🔴 night question']);
    await t.pass(10 * MINUTE);
    expect(t.texts()).toEqual(['🔴 night question', 'night result']);
  });

  it('"Updates: chat" pressed at 2:00 AM sends the held result at once, like a new one, not at 8:00 AM', async () => {
    const night = '2026-11-13T22:00:00.000Z'; // 2:00 AM in owner time, inside quiet hours
    const t = started(setup({ start: night, settings: DEFAULT_SETTINGS }));
    await t.router.post(result('held result'));
    await t.pass(2 * MINUTE);
    expect(t.texts()).toEqual([]);
    t.stub.mode = 'chat';
    t.stub.forced = true;
    t.stub.forcedUntil = iso(night, 62 * MINUTE);
    t.bus.emit('presence.updated', { mode: 'chat', online: false, clients: 0, forcedUntil: t.stub.forcedUntil });
    await t.pass(5_000);
    expect(t.texts()).toEqual(['held result']);
    expect(t.router.list().find((n) => n.text === 'held result')?.chatDueAt).not.toBe('2026-11-14T04:00:00.000Z');
    t.clock.advance(24_000);
    await t.router.post(result('new result'));
    expect(t.texts()).toEqual(['held result', 'new result']);
  });

  it('a backlog still leaves as at most three red questions and one digest when the switch is pressed at night', async () => {
    const night = '2026-11-13T22:00:00.000Z';
    const t = started(setup({ start: night, settings: DEFAULT_SETTINGS }));
    for (const text of ['r1', 'r2', 'r3', 'r4', 'r5']) await t.router.post(result(text));
    t.stub.mode = 'chat';
    t.stub.forced = true;
    t.stub.forcedUntil = iso(night, 60 * MINUTE);
    t.bus.emit('presence.updated', { mode: 'chat', online: false, clients: 0, forcedUntil: t.stub.forcedUntil });
    await t.pass(15_000);
    expect(t.chat.sent).toHaveLength(1);
    expect(t.texts()[0]).toMatch(/r1[\s\S]*r5/);
  });

  it('a send with no acknowledgement (queued by the channel, not refused) still counts as sent: no retry', async () => {
    const t = started(setup());
    await t.router.post(result());
    await t.pass(10 * MINUTE - 5_000);
    t.chat.isUp = () => true;
    t.chat.up = false;
    await t.pass(5_000);
    expect(t.chat.sent).toHaveLength(1);
    expect(t.delivered).toEqual([expect.objectContaining({ msgId: null })]);
    expect(t.router.list()[0]).toMatchObject({ settledVia: 'test-channel' });
    t.chat.up = true;
    await t.pass(20 * MINUTE);
    expect(t.chat.sent).toHaveLength(1);
  });

  it('10:10 AM the adapter refuses: retried on the next ticks, at most 3 times, then failed and the website told', async () => {
    const t = started(setup());
    const posted = await t.router.post(result('refused text'));
    t.chat.refuse = true;
    await t.pass(10 * MINUTE);
    expect(t.chat.sent).toHaveLength(1);
    expect(t.router.list()[0]).toMatchObject({ chatSentAt: null, chatDueAt: iso(T0, 10 * MINUTE) });
    await t.pass(15_000);
    expect(t.chat.sent).toHaveLength(4);
    expect(t.router.list()[0]).toMatchObject({ id: posted.notice?.id, chatSentAt: null, chatDueAt: null, settledAt: null });
    expect(t.updated.at(-1)).toMatchObject({ id: posted.notice?.id, chatDueAt: null });
    await t.pass(30 * MINUTE);
    expect(t.chat.sent).toHaveLength(4);
    expect(t.delivered).toEqual([]);
  });

  it('a refusal and then a success sends once', async () => {
    const t = started(setup());
    await t.router.post(result('second try works'));
    t.chat.refuse = true;
    await t.pass(10 * MINUTE);
    t.chat.refuse = false;
    await t.pass(5_000);
    expect(t.texts()).toEqual(['second try works', 'second try works']);
    expect(t.router.list()[0]).toMatchObject({ settledVia: 'test-channel' });
    await t.pass(30 * MINUTE);
    expect(t.chat.sent).toHaveLength(2);
  });

  it('with the link down at fallback time nothing is handed over; it goes out once when the link is back', async () => {
    const t = started(setup());
    await t.router.post(result('wait for the link'));
    t.chat.up = false;
    await t.pass(30 * MINUTE);
    expect(t.chat.sent).toEqual([]);
    expect(t.router.list()[0]).toMatchObject({ chatSentAt: null, settledAt: null });
    t.chat.up = true;
    await t.pass(5_000);
    expect(t.texts()).toEqual(['wait for the link']);
    await t.pass(20 * MINUTE);
    expect(t.texts()).toEqual(['wait for the link']);
  });
});
