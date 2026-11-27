import type { NoticeDTO, WsServerMessage } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { initialState, reducer, type AppAction, type AppState } from '../../src/state/reducer.js';
import {
  accounts, action, activityItem, chat, detail, item, luadyStatus, notice, overview, presence, question, server, session, step,
  channelInfo,
} from '../fixtures.js';

const ws = (message: WsServerMessage): AppAction => ({ type: 'ws.message', message });

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const SID = 'cedar:cc-meadow-hr:0.0';
const NOTICE: NoticeDTO = {
  id: 'n_01', kind: 'reply', text: 'Done.', ref: null, createdAt: '2026-11-14T10:00:00.000Z',
  chatDueAt: null, chatSentAt: null, settledAt: null, settledVia: null,
};

function loaded(): AppState {
  return deepFreeze(reducer(initialState, {
    type: 'overview.loaded',
    overview: overview({
      sessions: [session(), session({ id: 'hq:manager:0.0', host: 'hq', origin: 'system', displayName: 'manager' })],
      questions: [question(), question({ qid: 'ZZZZZZZZ', state: 'answered' })],
      actions: [action(), action({ id: 'A8', status: 'done' })],
    }),
  }));
}

const run = (state: AppState, ...actions: AppAction[]): AppState =>
  actions.reduce((current, next) => deepFreeze(reducer(current, next)), state);

describe('reducer', () => {
  it('counts every overview load, so the office can seat what a fresh load brings instead of walking it in', () => {
    expect(initialState.overviewVersion).toBe(0);
    const once = loaded();
    expect(once.overviewVersion).toBe(1);
    expect(run(once, { type: 'overview.loaded', overview: overview() }).overviewVersion).toBe(2);
  });

  it('loads the overview, hiding system sessions and resolved items', () => {
    const state = loaded();
    expect(state.loaded).toBe(true);
    expect(state.sessions.map((s) => s.id)).toEqual([SID]);
    expect(state.questions.map((q) => q.qid)).toEqual(['ABCDEFGH']);
    expect(state.actions.map((a) => a.id)).toEqual(['A7']);
    expect(state.luady?.state).toBe('running');
  });

  it('session.updated upserts owner sessions and ignores the brain', () => {
    const state = loaded();
    const working = run(state, { type: 'ws.message', message: { type: 'session.updated', session: session({ state: 'working' }) } });
    expect(working.sessions.map((s) => s.state)).toEqual(['working']);
    const brain = session({ id: 'hq:manager:0.0', host: 'hq', origin: 'system' });
    expect(run(state, { type: 'ws.message', message: { type: 'session.updated', session: brain } })).toBe(state);
    const added = run(state, { type: 'ws.message', message: { type: 'session.updated', session: session({ id: 'birch:cc-orchard:0.0', host: 'birch' }) } });
    expect(added.sessions).toHaveLength(2);
  });

  it('session.removed drops the session', () => {
    const state = run(loaded(), { type: 'ws.message', message: { type: 'session.removed', id: SID } });
    expect(state.sessions).toEqual([]);
  });

  it('question.updated keeps only pending questions', () => {
    const added = run(loaded(), { type: 'ws.message', message: { type: 'question.updated', question: question({ qid: 'QQQQQQQQ' }) } });
    expect(added.questions.map((q) => q.qid)).toEqual(['ABCDEFGH', 'QQQQQQQQ']);
    const resolved = run(added, { type: 'ws.message', message: { type: 'question.updated', question: question({ state: 'answered' }) } });
    expect(resolved.questions.map((q) => q.qid)).toEqual(['QQQQQQQQ']);
    expect(run(resolved, { type: 'question.removed', qid: 'QQQQQQQQ' }).questions).toEqual([]);
  });

  it('action.updated keeps only pending confirmations', () => {
    const added = run(loaded(), { type: 'ws.message', message: { type: 'action.updated', action: action({ id: 'A9' }) } });
    expect(added.actions.map((a) => a.id)).toEqual(['A7', 'A9']);
    const done = run(added, { type: 'ws.message', message: { type: 'action.updated', action: action({ status: 'done' }) } });
    expect(done.actions.map((a) => a.id)).toEqual(['A9']);
    expect(run(done, { type: 'action.removed', id: 'A9' }).actions).toEqual([]);
  });

  it('server.updated replaces the server by name', () => {
    const state = run(loaded(), { type: 'ws.message', message: { type: 'server.updated', server: server({ status: 'offline' }) } });
    expect(state.servers.map((s) => `${s.name}:${s.status}`)).toEqual(['cedar:offline']);
  });

  it('transcript.appended only touches open transcripts and never duplicates', () => {
    const state = loaded();
    const appended: AppAction = { type: 'ws.message', message: { type: 'transcript.appended', sessionId: SID, items: [item({ uuid: 'u9' })] } };
    expect(run(state, appended)).toBe(state);

    const buffered = run(state, { type: 'transcript.opened', sessionId: SID }, appended, appended);
    expect(buffered.transcripts[SID]?.items.map((i) => i.uuid)).toEqual(['u9']);
    const withPage = run(buffered, { type: 'transcript.loaded', sessionId: SID, items: [item({ uuid: 'u1' }), item({ uuid: 'u2' })], nextCursor: 'c1' });
    expect(withPage.transcripts[SID]).toMatchObject({ loaded: true, nextCursor: 'c1' });
    expect(withPage.transcripts[SID]?.items.map((i) => i.uuid)).toEqual(['u1', 'u2', 'u9']);
  });

  it('transcript.loaded merges a reconnect reload without losing older pages', () => {
    const base = run(loaded(),
      { type: 'transcript.loaded', sessionId: SID, items: [item({ uuid: 'u1' }), item({ uuid: 'u2' })], nextCursor: 'c1' },
      { type: 'transcript.older', sessionId: SID, items: [item({ uuid: 'u0' }), item({ uuid: 'u1' })], nextCursor: null });
    expect(base.transcripts[SID]?.items.map((i) => i.uuid)).toEqual(['u0', 'u1', 'u2']);

    const reload = run(base, { type: 'transcript.loaded', sessionId: SID, items: [item({ uuid: 'u2' }), item({ uuid: 'u3' })], nextCursor: 'c2' });
    expect(reload.transcripts[SID]?.items.map((i) => i.uuid)).toEqual(['u0', 'u1', 'u2', 'u3']);
    expect(reload.transcripts[SID]?.nextCursor).toBeNull();

    const gap = run(base, { type: 'transcript.loaded', sessionId: SID, items: [item({ uuid: 'u7' }), item({ uuid: 'u8' })], nextCursor: 'c7' });
    expect(gap.transcripts[SID]?.items.map((i) => i.uuid)).toEqual(['u7', 'u8']);
    expect(gap.transcripts[SID]?.nextCursor).toBe('c7');
  });

  it('transcript.closed forgets the transcript', () => {
    const state = run(loaded(), { type: 'transcript.opened', sessionId: SID }, { type: 'transcript.closed', sessionId: SID });
    expect(state.transcripts).toEqual({});
  });

  it('keeps the Luady thread sorted and settles pending owner messages', () => {
    const state = run(loaded(),
      { type: 'luady.pending', localId: 'local-1', text: 'check cedar disk', ts: '2026-10-09T12:05:00.000Z' },
      { type: 'luady.loaded', items: [chat({ id: 'm2', ts: '2026-10-09T12:01:00.000Z' }), chat({ id: 'm1', role: 'owner', text: 'status?', ts: '2026-10-09T12:00:00.000Z' })], nextCursor: 'k1' });
    expect(state.luadyThread.items.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(state.luadyThread.pending.map((p) => p.status)).toEqual(['sending']);

    const sent = run(state, { type: 'luady.pendingSent', localId: 'local-1' });
    expect(sent.luadyThread.pending.map((p) => p.status)).toEqual(['sent']);
    const echoed = run(sent, { type: 'ws.message', message: { type: 'manager.message', message: chat({ id: 'm3', role: 'owner', text: 'check cedar disk', ts: '2026-10-09T12:05:01.000Z' }) } });
    expect(echoed.luadyThread.pending).toEqual([]);
    expect(echoed.luadyThread.items.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);

    const failed = run(state, { type: 'luady.pendingFailed', localId: 'local-1' });
    expect(failed.luadyThread.pending).toEqual([]);
    const older = run(state, { type: 'luady.older', items: [chat({ id: 'm0', ts: '2026-10-09T11:00:00.000Z' })], nextCursor: null });
    expect(older.luadyThread.items.map((m) => m.id)).toEqual(['m0', 'm1', 'm2']);
  });

  it('tracks Luady, the chat channel and connection status', () => {
    const state = run(loaded(),
      { type: 'ws.message', message: { type: 'manager.status', status: luadyStatus({ state: 'busy' }) } },
      { type: 'ws.message', message: { type: 'channel.status', channel: channelInfo({ state: 'down' }) } },
      { type: 'connection.changed', status: 'reconnecting', epoch: 1 });
    expect(state.luady?.state).toBe('busy');
    expect(state.channels.map((c) => [c.id, c.state])).toEqual([['test-channel', 'down']]);
    expect(state.connection).toEqual({ status: 'reconnecting', epoch: 1 });
  });

  it('starts the live-activity slices empty', () => {
    expect(initialState).toMatchObject({ activity: {}, details: {}, notices: [], presence: null, accounts: null, accountsVersion: 0 });
  });

  it('keeps live activity from the load and from activity.updated', () => {
    const state = run(loaded(),
      { type: 'activity.loaded', items: [activityItem()] },
      ws({ type: 'activity.updated', items: [activityItem({ tool: 'run', contextPct: 12 })] }));
    expect(state.activity[SID]).toMatchObject({ tool: 'run', contextPct: 12 });
  });

  it('applies steps only to a detail that is open, and the same state object otherwise', () => {
    const message: WsServerMessage = { type: 'steps.appended', sessionId: SID, steps: [step({ id: 's2' })], todos: null, helpers: null };
    const closed = loaded();
    expect(reducer(closed, { type: 'ws.message', message })).toBe(closed);
    const opened = run(closed, { type: 'detail.opened', sessionId: SID }, { type: 'detail.loaded', detail: detail() });
    const next = run(opened, ws(message), ws(message));
    expect(next.details[SID]?.steps.map((s) => s.id)).toEqual(['toolu_01', 's2']);
    expect(run(next, { type: 'detail.closed', sessionId: SID }).details).toEqual({});
  });

  it('ignores a detail that loads after its view was closed', () => {
    const state = run(loaded(), { type: 'detail.loaded', detail: detail() });
    expect(state.details).toEqual({});
  });

  it('follows a pause on the map in the open detail', () => {
    const opened = run(loaded(), { type: 'detail.opened', sessionId: SID }, { type: 'detail.loaded', detail: detail({ paused: true, pauseHit: true }) });
    const resumed = run(opened, ws({ type: 'activity.updated', items: [activityItem({ paused: false })] }));
    expect(resumed.details[SID]).toMatchObject({ paused: false, pauseHit: false });
  });

  it('session.removed drops that session’s activity and detail', () => {
    const state = run(loaded(),
      { type: 'activity.loaded', items: [activityItem()] },
      { type: 'detail.opened', sessionId: SID },
      ws({ type: 'session.removed', id: SID }));
    expect(state.activity).toEqual({});
    expect(state.details).toEqual({});
  });

  it('keeps notices newest first and upserts them from the socket', () => {
    const state = run(loaded(),
      { type: 'notices.loaded', items: [notice({ id: 'old', createdAt: '2026-10-09T11:00:00.000Z' }), notice({ id: 'n1' })] },
      ws({ type: 'notice.created', notice: NOTICE }),
      ws({ type: 'notice.updated', notice: { ...NOTICE, settledAt: NOTICE.createdAt, settledVia: 'web' } }));
    expect(state.notices.map((n) => n.id)).toEqual(['n_01', 'n1', 'old']);
    expect(state.notices[0]?.settledVia).toBe('web');
  });

  it('a presence reading fetched before a pushed update never overwrites it', () => {
    const start = loaded();
    const pushed = run(start, ws({ type: 'presence.updated', presence: presence({ mode: 'here' }) }));
    expect(pushed.presenceVersion).toBe(start.presenceVersion + 1);
    const stale = run(pushed, { type: 'presence.loaded', presence: presence({ mode: 'chat', online: false }), version: start.presenceVersion });
    expect(stale.presence?.mode).toBe('here');
    const current = run(pushed, { type: 'presence.loaded', presence: presence({ mode: 'chat' }), version: pushed.presenceVersion });
    expect(current.presence?.mode).toBe('chat');
  });

  it('sets presence and accounts, and counts accounts.changed', () => {
    const state = run(loaded(),
      { type: 'presence.loaded', presence: presence() },
      ws({ type: 'presence.updated', presence: presence({ mode: 'chat' }) }),
      { type: 'accounts.loaded', accounts: accounts() },
      ws({ type: 'accounts.changed', at: NOTICE.createdAt }),
      ws({ type: 'accounts.changed', at: NOTICE.createdAt }));
    expect(state.presence?.mode).toBe('chat');
    expect(state.accounts?.accounts).toHaveLength(1);
    expect(state.accountsVersion).toBe(2);
  });

  it('caps toasts at four and dismisses by id', () => {
    const pushes = [1, 2, 3, 4, 5].map((n): AppAction => ({ type: 'toast.push', kind: 'info', text: `t${n}` }));
    const state = run(initialState, ...pushes);
    expect(state.toasts.map((t) => t.text)).toEqual(['t2', 't3', 't4', 't5']);
    const dismissed = run(state, { type: 'toast.dismiss', id: state.toasts[0]?.id ?? -1 });
    expect(dismissed.toasts.map((t) => t.text)).toEqual(['t3', 't4', 't5']);
  });
});
