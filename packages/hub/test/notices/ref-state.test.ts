import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type ActionDTO, type HostId, type QuestionDTO, type Settings } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createRefState, REF_WAIT_MAX_MS } from '../../src/notices/ref-state.js';
import { createNoticeRouter, NOTICE_TICK_MS, type NoticeRouter } from '../../src/notices/router.js';
import { sampleAction, sampleQuestion } from '../web/helpers.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { createFakeChat } from './fake-chat.js';

const T0 = '2026-11-14T12:30:00.000Z'; // 4:30 PM in owner time: the hub restarts
const SECOND = 1_000;
const NO_QUIET: Settings = { ...DEFAULT_SETTINGS, quiet_hours: { start: '00:00', end: '00:00', tz: 'Etc/GMT-4' } };

function states(over: { question?: QuestionDTO; action?: ActionDTO; reconciled?: ReadonlySet<HostId> } = {}) {
  const clock = createFakeClock(T0);
  let reconciled: ReadonlySet<HostId> = over.reconciled ?? new Set();
  const refState = createRefState({
    clock, startedAt: clock.now().getTime(),
    action: (id) => (over.action?.id === id ? over.action : undefined),
    question: (qid) => (over.question?.qid === qid ? over.question : undefined),
    reconciled: (host) => reconciled.has(host),
  });
  return { clock, refState, report: (host: HostId) => { reconciled = new Set([...reconciled, host]); } };
}

describe('ref state: is the question behind a notice still waiting?', () => {
  it('waits for the server: unknown at 4:31 PM, open at 4:32 PM when the server never reported in', () => {
    const t = states({ question: sampleQuestion({ qid: 'Q1', host: 'cedar' }) });
    expect(t.refState({ kind: 'question', id: 'Q1' })).toBe('unknown');
    t.clock.advance(REF_WAIT_MAX_MS - SECOND);
    expect(t.refState({ kind: 'question', id: 'Q1' })).toBe('unknown');
    t.clock.advance(SECOND);
    expect(t.refState({ kind: 'question', id: 'Q1' })).toBe('open');
  });

  it('is open as soon as the server reports in, before the two minutes are up', () => {
    const t = states({ question: sampleQuestion({ qid: 'Q1', host: 'birch' }) });
    t.clock.advance(30 * SECOND);
    expect(t.refState({ kind: 'question', id: 'Q1' })).toBe('unknown');
    t.report('birch');
    expect(t.refState({ kind: 'question', id: 'Q1' })).toBe('open');
  });

  it('an answered, released or unknown question is closed at once, even before its server reported in', () => {
    expect(states({ question: sampleQuestion({ qid: 'Q1', state: 'answered' }) }).refState({ kind: 'question', id: 'Q1' })).toBe('closed');
    expect(states({ question: sampleQuestion({ qid: 'Q1', state: 'released' }) }).refState({ kind: 'question', id: 'Q1' })).toBe('closed');
    expect(states().refState({ kind: 'question', id: 'nope' })).toBe('closed');
  });

  it('a confirmation is open only while it waits for its PIN', () => {
    expect(states({ action: sampleAction({ id: 'A7', status: 'pending_confirmation' }) }).refState({ kind: 'action', id: 'A7' })).toBe('open');
    expect(states({ action: sampleAction({ id: 'A7', status: 'denied' }) }).refState({ kind: 'action', id: 'A7' })).toBe('closed');
  });
});

describe('a red question whose server never comes back after a restart', () => {
  let router: NoticeRouter | null = null;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });
  afterEach(() => {
    router?.stop();
    vi.useRealTimers();
  });

  it('asked at 4:10 PM, hub restarts at 4:30 PM, cedar stays offline: the chat gets it at 4:32 PM, not before', async () => {
    const db = openMemoryDb();
    const settings = { get: () => NO_QUIET };
    const presence = { state: () => ({ mode: 'here' as const, online: true, clients: 1, forcedUntil: null }), forced: () => false, capable: () => true };
    const noticeState = { webTabHello: () => true, setWebTabHello: () => undefined };
    const before = createFakeClock('2026-11-14T12:10:00.000Z');
    const old = createNoticeRouter({ db, bus: createBus(), clock: before, log: silentLogger(), chat: createFakeChat(), presence, state: noticeState, settings });
    await old.post({ kind: 'question', source: 'hub', text: '🔴 Which DB?', ref: { kind: 'question', id: 'Q1' } });

    const t = states({ question: sampleQuestion({ qid: 'Q1', host: 'cedar' }) });
    const chat = createFakeChat();
    router = createNoticeRouter({ db, bus: createBus(), clock: t.clock, log: silentLogger(), chat, presence, state: noticeState, settings, refState: t.refState });
    router.start();
    const pass = async (ms: number): Promise<void> => {
      for (let left = ms; left > 0; left -= NOTICE_TICK_MS) {
        t.clock.advance(NOTICE_TICK_MS);
        await vi.advanceTimersByTimeAsync(NOTICE_TICK_MS);
      }
    };
    await pass(REF_WAIT_MAX_MS - NOTICE_TICK_MS);
    expect(chat.sent).toEqual([]);
    await pass(2 * NOTICE_TICK_MS);
    expect(chat.sent.map((s) => s.text)).toEqual(['🔴 Which DB?']);
  });
});
