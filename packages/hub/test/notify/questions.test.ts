import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type NoticeDTO, type PresenceDTO, type QuestionDTO, type SessionDTO, type Settings } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Clock, Db, QuestionService, SessionService, SettingsService } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { noticeChannel } from '../../src/notices/channel.js';
import { createNoticeRouter } from '../../src/notices/router.js';
import { createQuestionNotifier } from '../../src/notify/questions.js';
import { silentLogger, type FakeOutbound } from '../../test/helpers/fakes.js';
import { CHAT_ID, createFakeChat } from '../notices/fake-chat.js';
import type { ChatSender } from '../../src/notices/router.js';

const T0 = '2026-10-09T12:00:00.000Z'; // 16:00 in owner time
const MINUTE = 60_000;
const clock: Clock = { now: () => new Date() };

interface RowOverrides { created_at?: string; notified_at?: string | null; escalated_at?: string | null }

function insertQuestion(db: Db, qid: string, over: RowOverrides): void {
  db.prepare(
    `INSERT INTO questions (qid, kind, host, session_id, payload_json, state, created_at, notified_at, escalated_at)
     VALUES (?, 'question', 'cedar', 'cedar:cc-meadow-hr:0.0', '{}', 'pending', ?, ?, ?)`,
  ).run(qid, over.created_at ?? T0, over.notified_at ?? null, over.escalated_at ?? null);
}

function questionDto(qid: string, state: QuestionDTO['state']): QuestionDTO {
  return {
    qid, kind: 'question', host: 'cedar', sessionId: 'cedar:cc-meadow-hr:0.0', sessionLabel: 'meadow-hr',
    questions: [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
    permission: null, state, createdAt: T0, resolvedAt: null, resolvedVia: null,
  };
}

function fakeSessions(): SessionService {
  const session: SessionDTO = {
    id: 'cedar:cc-meadow-hr:0.0', host: 'cedar', target: 'cc-meadow-hr:0.0', claudeSessionId: 'c-1',
    cwd: '/home/dev/projects/meadow-hr', project: 'meadow-hr', displayName: 'meadow-hr', state: 'waiting_question',
    origin: 'owner', registered: true, lastEventAt: null, turnStartedAt: null, pendingQid: null, unexpectedEnd: false,
  };
  return {
    list: () => [session], get: (id) => (id === session.id ? session : undefined), findByRef: () => undefined,
    send: vi.fn(), interrupt: vi.fn(), start: vi.fn(), stop: vi.fn(), restart: vi.fn(), remove: vi.fn(),
    transcript: vi.fn(), condensed: vi.fn(),
  };
}

/** Like the real channel: a message the chat accepted gets its channel_links row (the reply link). */
function linkingChat(db: Db): FakeOutbound & ChatSender {
  const raw = createFakeChat();
  const linkIt = (msgId: string | null, link: { kind: string; refId: string } | null): void => {
    if (msgId !== null && link !== null) {
      db.prepare('INSERT OR REPLACE INTO channel_links (channel, msg_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(CHAT_ID, msgId, link.kind, link.refId, new Date().toISOString());
    }
  };
  const send = raw.send;
  raw.send = async (text, link, quotedId) => {
    const msgId = await send(text, link, quotedId);
    linkIt(msgId, link);
    return msgId;
  };
  const sendChecked = raw.sendChecked;
  raw.sendChecked = async (text, link, quotedId) => {
    const ack = await sendChecked(text, link, quotedId);
    linkIt(ack.msgId, link);
    return ack;
  };
  return raw;
}

function setup(opts: { settings?: Partial<Settings>; phoneEnabled?: boolean; website?: boolean } = {}) {
  const db = openMemoryDb();
  const bus = createBus();
  const dtos = new Map<string, QuestionDTO>();
  const stamp = (column: 'notified_at' | 'escalated_at', qid: string): void => {
    db.prepare(`UPDATE questions SET ${column} = ? WHERE qid = ?`).run(new Date().toISOString(), qid);
  };
  const questions = {
    pending: () => [...dtos.values()].filter((q) => q.state === 'pending'),
    get: (qid: string) => dtos.get(qid),
    answer: vi.fn(), answerPermission: vi.fn(), release: vi.fn(),
    markNotified: vi.fn((qid: string) => stamp('notified_at', qid)),
    markEscalated: vi.fn((qid: string) => stamp('escalated_at', qid)),
  } satisfies QuestionService;
  const phone = {
    enabled: () => opts.phoneEnabled ?? true,
    callForQuestion: vi.fn(async (_qid: string): Promise<void> => undefined),
    callOwner: vi.fn(async (_reason: string): Promise<void> => undefined),
  };
  const settings: SettingsService = { get: () => ({ ...DEFAULT_SETTINGS, phone_enabled: true, ...opts.settings }), update: vi.fn() };
  const chat = linkingChat(db);
  const mode: PresenceDTO['mode'] = opts.website === true ? 'here' : 'chat';
  const presence = { state: (): PresenceDTO => ({ mode, online: mode === 'here', clients: 1, forcedUntil: null }), forced: () => false, capable: () => true };
  const router = createNoticeRouter({ state: { webTabHello: () => true, setWebTabHello: () => undefined },  db, bus, clock, log: silentLogger(), chat, presence, settings });
  const outbound = noticeChannel({ router, chat, questions }, { kind: 'alert', source: 'hub' });
  const notifier = createQuestionNotifier({
    db, bus, clock, log: silentLogger(), outbound, settings, questions, sessions: fakeSessions(), phone,
  });
  notifier.start();
  router.start();
  const add = (qid: string, over: RowOverrides = {}): QuestionDTO => {
    insertQuestion(db, qid, over);
    const dto = questionDto(qid, 'pending');
    dtos.set(qid, dto);
    return dto;
  };
  const resolve = (qid: string): QuestionDTO => {
    const dto = questionDto(qid, 'answered');
    dtos.set(qid, dto);
    return dto;
  };
  const stop = (): void => {
    notifier.stop();
    router.stop();
  };
  return { db, bus, notifier, router, chat, phone, questions, add, resolve, stop };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: new Date(T0) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createQuestionNotifier, website off', () => {
  it('sends a pending question once with a question link and marks it notified', async () => {
    const t = setup();
    const q = t.add('ABCDEFGH');
    await t.notifier.onQuestion(q);
    await t.notifier.onQuestion(q);
    expect(t.chat.sent).toHaveLength(1);
    expect(t.chat.sent[0]?.text).toContain('🔴 *Needs your answer* · cedar · meadow-hr  #ABCDEFGH');
    expect(t.chat.sent[0]?.link).toEqual({ kind: 'question', refId: 'ABCDEFGH' });
    expect(t.questions.markNotified).toHaveBeenCalledWith('ABCDEFGH');
    t.stop();
  });

  it('pins the question until it is answered, then unpins it', async () => {
    const t = setup();
    await t.notifier.onQuestion(t.add('ABCDEFGH'));
    expect(t.chat.pins).toEqual([{ msgId: 'fake-wa-1', on: true }]);
    await t.notifier.onQuestion(t.resolve('ABCDEFGH'));
    expect(t.chat.pins).toEqual([{ msgId: 'fake-wa-1', on: true }, { msgId: 'fake-wa-1', on: false }]);
    t.stop();
  });

  it('sends only one message when two events for the same question race', async () => {
    const t = setup();
    const q = t.add('ABCDEFGH');
    await Promise.all([t.notifier.onQuestion(q), t.notifier.onQuestion(q)]);
    expect(t.chat.sent).toHaveLength(1);
    t.stop();
  });

  it('escalates escalate_after_min after the red message reached the chat', async () => {
    const t = setup();
    t.add('ABCDEFGH', { created_at: '2026-10-09T11:50:00.000Z' });
    await t.notifier.onQuestion(t.questions.get('ABCDEFGH') ?? questionDto('ABCDEFGH', 'pending'));
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(t.phone.callForQuestion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(t.phone.callForQuestion).toHaveBeenCalledWith('ABCDEFGH');
    expect(t.questions.markEscalated).toHaveBeenCalledWith('ABCDEFGH');
    t.stop();
  });

  it('escalates from the hand-over even when the link was down and the channel queued the message', async () => {
    const t = setup();
    t.chat.up = false;
    await t.notifier.onQuestion(t.add('ABCDEFGH'));
    expect(t.chat.pins).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(t.phone.callForQuestion).toHaveBeenCalledWith('ABCDEFGH');
    t.stop();
  });

  it('does not call when the phone is unavailable or phone_enabled is off', async () => {
    const unavailable = setup({ phoneEnabled: false });
    await unavailable.notifier.onQuestion(unavailable.add('ABCDEFGH'));
    const switchedOff = setup({ settings: { phone_enabled: false } });
    await switchedOff.notifier.onQuestion(switchedOff.add('QRSTUVWX'));
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(unavailable.phone.callForQuestion).not.toHaveBeenCalled();
    expect(switchedOff.phone.callForQuestion).not.toHaveBeenCalled();
    unavailable.stop();
    switchedOff.stop();
  });

  it('respects quiet hours unless night_calls is on', async () => {
    const night = '2026-10-09T21:00:00.000Z'; // 01:00 in owner time
    vi.setSystemTime(new Date(night));
    const quiet = setup();
    await quiet.notifier.onQuestion(quiet.add('ABCDEFGH', { created_at: night }));
    const nightCalls = setup({ settings: { night_calls: true } });
    await nightCalls.notifier.onQuestion(nightCalls.add('QRSTUVWX', { created_at: night }));
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(quiet.phone.callForQuestion).not.toHaveBeenCalled();
    expect(nightCalls.phone.callForQuestion).toHaveBeenCalledWith('QRSTUVWX');
    quiet.stop();
    nightCalls.stop();
  });

  it('cancels the escalation when the question is resolved', async () => {
    const t = setup();
    await t.notifier.onQuestion(t.add('ABCDEFGH'));
    await t.notifier.onQuestion(t.resolve('ABCDEFGH'));
    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    expect(t.phone.callForQuestion).not.toHaveBeenCalled();
    t.stop();
  });

  it('restore() sends never-notified questions and arms escalation only where a chat message exists', async () => {
    const t = setup();
    t.add('ABCDEFGH', { created_at: '2026-10-09T11:55:00.000Z' });
    t.add('QRSTUVWX', { created_at: '2026-10-09T11:56:00.000Z', notified_at: '2026-10-09T11:56:01.000Z' });
    t.db.prepare("INSERT INTO channel_links (channel, msg_id, kind, ref_id, created_at) VALUES ('test-channel', 'old-1', 'question', 'QRSTUVWX', '2026-10-09T11:56:00.000Z')").run();
    t.add('WEBONLY1', { created_at: '2026-10-09T11:57:00.000Z', notified_at: '2026-10-09T11:57:01.000Z' });
    t.add('ZZZZZZZZ', { notified_at: T0, escalated_at: T0 });
    await t.notifier.restore();
    expect(t.chat.sent.map((s) => s.link?.refId)).toEqual(['ABCDEFGH']);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    expect(t.phone.callForQuestion.mock.calls.map(([qid]) => qid)).toEqual(['QRSTUVWX']);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(t.phone.callForQuestion.mock.calls.map(([qid]) => qid)).toEqual(['QRSTUVWX', 'ABCDEFGH']);
    t.stop();
  });
});

describe('createQuestionNotifier, website on', () => {
  it('sends and pins nothing, marks the question notified and arms no escalation', async () => {
    const t = setup({ website: true });
    await t.notifier.onQuestion(t.add('ABCDEFGH'));
    expect(t.chat.sent).toEqual([]);
    expect(t.chat.pins).toEqual([]);
    expect(t.questions.markNotified).toHaveBeenCalledWith('ABCDEFGH');
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(t.phone.callForQuestion).not.toHaveBeenCalled();
    t.stop();
  });

  it('the fallback at minute 10 sends the red message, pins it and arms the escalation from then', async () => {
    const t = setup({ website: true });
    await t.notifier.onQuestion(t.add('ABCDEFGH'));
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(t.chat.sent.map((s) => s.link)).toEqual([{ kind: 'question', refId: 'ABCDEFGH' }]);
    expect(t.chat.pins).toEqual([{ msgId: 'fake-wa-1', on: true }]);
    expect(t.phone.callForQuestion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    expect(t.phone.callForQuestion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(t.phone.callForQuestion).toHaveBeenCalledWith('ABCDEFGH');
    t.stop();
  });

  it('answered on the website at minute 9: no chat message, no pin, no call', async () => {
    const t = setup({ website: true });
    await t.notifier.onQuestion(t.add('ABCDEFGH'));
    await vi.advanceTimersByTimeAsync(9 * MINUTE);
    const answered = t.resolve('ABCDEFGH');
    t.bus.emit('question.updated', answered);
    await t.notifier.onQuestion(answered);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(t.chat.sent).toEqual([]);
    expect(t.chat.pins).toEqual([]);
    expect(t.phone.callForQuestion).not.toHaveBeenCalled();
    t.stop();
  });

  it('a delivered notice that is not a question changes nothing', async () => {
    const t = setup({ website: true });
    const notice: NoticeDTO = {
      id: 'n1', kind: 'result', text: 'done', ref: { kind: 'session', id: 'cedar:cc-meadow-hr:0.0' }, createdAt: T0,
      chatDueAt: null, chatSentAt: T0, settledAt: T0, settledVia: 'test-channel',
    };
    t.bus.emit('notice.delivered', { notice, msgId: 'wamid.1' });
    expect(t.chat.pins).toEqual([]);
    t.stop();
  });

  it('after a restart, restore() arms the escalation from the due time of a question still on the website', async () => {
    const t = setup({ website: true });
    await t.notifier.onQuestion(t.add('ABCDEFGH'));
    t.stop();
    const restarted = createQuestionNotifier({
      db: t.db, bus: t.bus, clock, log: silentLogger(), outbound: createFakeChat(),
      settings: { get: () => ({ ...DEFAULT_SETTINGS, phone_enabled: true }), update: vi.fn() },
      questions: t.questions, sessions: fakeSessions(), phone: t.phone,
    });
    await restarted.restore();
    await vi.advanceTimersByTimeAsync(19 * MINUTE);
    expect(t.phone.callForQuestion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(t.phone.callForQuestion).toHaveBeenCalledWith('ABCDEFGH');
    restarted.stop();
  });

  it('4:00 PM red question, the chat down from 4:05 to 5:00: the call comes at 4:20, not 10 minutes after the link returns', async () => {
    const t = setup({ website: true });
    await t.notifier.onQuestion(t.add('ABCDEFGH'));
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    t.chat.up = false;
    await vi.advanceTimersByTimeAsync(14 * MINUTE);
    expect(t.chat.sent).toEqual([]);
    expect(t.phone.callForQuestion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(t.phone.callForQuestion).toHaveBeenCalledWith('ABCDEFGH');
    await vi.advanceTimersByTimeAsync(40 * MINUTE);
    t.chat.up = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.chat.sent.map((s) => s.link)).toEqual([{ kind: 'question', refId: 'ABCDEFGH' }]);
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(t.phone.callForQuestion).toHaveBeenCalledTimes(1);
    t.stop();
  });
});
