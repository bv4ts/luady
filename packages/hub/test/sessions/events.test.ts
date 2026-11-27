import { describe, expect, it } from 'vitest';
import { promptHash, type HostId, type SpoolEvent } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { HubEvents } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createMemoryService } from '../../src/memory/service.js';
import { createSessionEventHandler } from '../../src/sessions/events.js';
import { createSessionsRepo } from '../../src/sessions/repo.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { notification, prompt, question, report, sessionEnd, sessionStart, stop, stopFailure } from './spool-events.js';

const ID = 'cedar:cc-meadow-hr:0.0';
const WATCHED = ['session.updated', 'turn.finished', 'session.failed', 'session.ended', 'usage.notice', 'session.report'] as const;

function setup(isHeld?: (sessionId: string) => boolean) {
  const db = openMemoryDb();
  const bus = createBus();
  const clock = createFakeClock('2026-10-09T12:00:00.000Z');
  const repo = createSessionsRepo(db);
  const handler = createSessionEventHandler({
    repo, bus, memory: createMemoryService({ db, clock }), log: silentLogger(), ...(isHeld === undefined ? {} : { isHeld }),
  });
  const seen: Array<{ name: keyof HubEvents; payload: unknown }> = [];
  for (const name of WATCHED) bus.on(name, (payload) => seen.push({ name, payload }));
  const apply = (event: SpoolEvent, replay = false, host: HostId = 'cedar'): void => handler.apply(host, event, replay);
  const messages = (): unknown[] => db.prepare('SELECT thread, role, text FROM messages ORDER BY ts, rowid').all();
  const payloadOf = (name: keyof HubEvents): unknown => seen.find((entry) => entry.name === name)?.payload;
  return { repo, seen, apply, messages, payloadOf, handler };
}

describe('createSessionEventHandler', () => {
  it('creates a row on session_start and emits session.updated', () => {
    const { repo, seen, apply } = setup();
    apply(sessionStart('startup'));
    expect(repo.get(ID)).toMatchObject({
      state: 'idle',
      claudeSessionId: 'claude-a',
      registered: true,
      origin: 'owner',
      project: 'meadow-hr',
      displayName: 'meadow-hr',
    });
    expect(seen).toEqual([
      { name: 'session.updated', payload: expect.objectContaining({ id: ID, state: 'idle', host: 'cedar', target: 'cc-meadow-hr:0.0' }) },
    ]);
  });

  it('tracks a turn and reports its duration on stop', () => {
    const { repo, apply, messages, payloadOf } = setup();
    apply(sessionStart('startup'));
    apply(prompt('add a health endpoint', { ts: '2026-10-09T12:00:00.000Z' }));
    expect(repo.get(ID)?.state).toBe('working');
    apply(stop('Added /health.', { ts: '2026-10-09T12:14:00.000Z' }));
    expect(payloadOf('turn.finished')).toMatchObject({
      durationSec: 840,
      remote: false,
      lastMessage: 'Added /health.',
      replay: false,
      session: expect.objectContaining({ state: 'idle', turnStartedAt: null }),
    });
    expect(messages()).toEqual([
      { thread: `session:${ID}`, role: 'user', text: 'add a health endpoint' },
      { thread: `session:${ID}`, role: 'assistant', text: 'Added /health.' },
    ]);
  });

  it('a Stop while a pause flag is set but not hit yet is a real end of turn', () => {
    const { seen, apply, messages, payloadOf } = setup(() => false);
    apply(sessionStart('startup'));
    apply(prompt('add a health endpoint', { ts: '2026-10-09T12:00:00.000Z' }));
    seen.splice(0);
    apply(stop('Added /health.', { ts: '2026-10-09T12:03:00.000Z' }));
    expect(seen.map((entry) => entry.name)).toEqual(['session.updated', 'turn.finished']);
    expect(payloadOf('turn.finished')).toMatchObject({ durationSec: 180, lastMessage: 'Added /health.' });
    expect(messages()).toContainEqual({ thread: `session:${ID}`, role: 'assistant', text: 'Added /health.' });
  });

  it('a Stop after the pause hit is held; a release that typed nothing reports it once', () => {
    let held = true;
    const { seen, apply, messages, handler, payloadOf } = setup((id) => held && id === ID);
    apply(sessionStart('startup'));
    apply(prompt('add a health endpoint', { ts: '2026-10-09T12:00:00.000Z' }));
    seen.splice(0);
    apply(stop('Added /health.', { ts: '2026-10-09T12:03:00.000Z' }));
    expect(seen.map((entry) => entry.name)).toEqual(['session.updated']);
    expect(messages()).toEqual([{ thread: `session:${ID}`, role: 'user', text: 'add a health endpoint' }]);
    held = false;
    handler.release(ID, false);
    expect(seen.map((entry) => entry.name)).toEqual(['session.updated', 'turn.finished']);
    expect(payloadOf('turn.finished')).toMatchObject({ durationSec: 180, lastMessage: 'Added /health.', session: expect.objectContaining({ id: ID }) });
    expect(messages()).toContainEqual({ thread: `session:${ID}`, role: 'assistant', text: 'Added /health.' });
    handler.release(ID, false);
    expect(seen.filter((entry) => entry.name === 'turn.finished')).toHaveLength(1);
  });

  it('a release whose resume text was typed keeps the held turn going: stored, not reported', () => {
    let held = true;
    const { seen, apply, messages, handler } = setup(() => held);
    apply(sessionStart('startup'));
    apply(prompt('add a health endpoint', { ts: '2026-10-09T12:00:00.000Z' }));
    apply(stop('Halfway there.', { ts: '2026-10-09T12:03:00.000Z' }));
    held = false;
    handler.release(ID, true);
    expect(seen.filter((entry) => entry.name === 'turn.finished')).toEqual([]);
    expect(messages()).toContainEqual({ thread: `session:${ID}`, role: 'assistant', text: 'Halfway there.' });
    apply(prompt('The owner has lifted the pause. Continue from where you paused.', { ts: '2026-10-09T12:10:00.000Z' }));
    apply(stop('Done.', { ts: '2026-10-09T12:11:00.000Z' }));
    expect(seen.filter((entry) => entry.name === 'turn.finished')).toHaveLength(1);
  });

  it('marks a turn remote when the prompt hash matches a recent injection', () => {
    const { repo, apply, payloadOf } = setup();
    apply(sessionStart('startup'));
    repo.recordInjection(ID, promptHash('fix the tests'), 'test-channel', '2026-10-09T11:59:30.000Z');
    apply(prompt('  fix the tests\n', { ts: '2026-10-09T12:00:00.000Z' }));
    expect(repo.get(ID)?.turnRemote).toBe(true);
    apply(stop('Fixed.', { ts: '2026-10-09T12:01:00.000Z' }));
    expect(payloadOf('turn.finished')).toMatchObject({ remote: true, durationSec: 60 });
  });

  it('marks a turn remote when any injection landed within 15 s', () => {
    const { repo, apply } = setup();
    apply(sessionStart('startup'));
    repo.recordInjection(ID, promptHash('something else'), 'web', '2026-10-09T11:59:50.000Z');
    apply(prompt('pasted text that the TUI changed', { ts: '2026-10-09T12:00:00.000Z' }));
    expect(repo.get(ID)?.turnRemote).toBe(true);
  });

  it('does not treat old injections as remote', () => {
    const { repo, apply } = setup();
    apply(sessionStart('startup'));
    repo.recordInjection(ID, promptHash('fix the tests'), 'test-channel', '2026-10-09T11:58:30.000Z');
    apply(prompt('fix the tests', { ts: '2026-10-09T12:00:00.000Z' }));
    expect(repo.get(ID)?.turnRemote).toBe(false);
  });

  it('queued prompt absorbed into the running turn (UPS(B), Stop(A), Stop(B))', () => {
    const { repo, apply, seen } = setup();
    apply(sessionStart('startup'));
    apply(prompt('task A', { ts: '2026-10-09T12:00:00.000Z' }));
    repo.recordInjection(ID, promptHash('task B'), 'test-channel', '2026-10-09T12:04:50.000Z');
    apply(prompt('task B', { ts: '2026-10-09T12:05:00.000Z' }));
    apply(stop('A done', { ts: '2026-10-09T12:05:05.000Z' }));
    apply(stop('B done', { ts: '2026-10-09T12:07:05.000Z' }));
    const finished = seen.filter((e) => e.name === 'turn.finished').map((e) => e.payload);
    expect(finished).toEqual([
      expect.objectContaining({ lastMessage: 'A done', remote: true, durationSec: 305 }),
      expect.objectContaining({ lastMessage: 'B done', remote: false, durationSec: 120 }),
    ]);
    expect(repo.get(ID)).toMatchObject({ turnStartedAt: null, turnRemote: false });
  });

  it('emits session.failed, usage.notice and session.ended', () => {
    const { repo, seen, apply } = setup();
    apply(sessionStart('startup'));
    apply(stopFailure('API Error: 529 overloaded'));
    expect(repo.get(ID)?.state).toBe('error');
    apply(notification('quota_exceeded', 'You have hit your usage limit.'));
    apply(sessionEnd('prompt_input_exit'));
    expect(seen.filter((entry) => entry.name !== 'session.updated')).toEqual([
      { name: 'session.failed', payload: expect.objectContaining({ error: 'API Error: 529 overloaded', replay: false }) },
      { name: 'usage.notice', payload: expect.objectContaining({ message: 'You have hit your usage limit.' }) },
      { name: 'session.ended', payload: expect.objectContaining({ unexpected: false, reason: 'prompt_input_exit' }) },
    ]);
    expect(repo.get(ID)?.state).toBe('ended');
  });

  it('passes a mid-turn report on at once, keeping the turn running and the project of the row', () => {
    const { repo, apply, payloadOf } = setup();
    apply(sessionStart('startup'));
    apply(prompt('make a fresh test account', { ts: '2026-10-09T12:00:00.000Z' }));
    apply(report('Fresh account: a@x.com / pw', { ts: '2026-10-09T12:03:00.000Z' }));
    expect(payloadOf('session.report')).toEqual({
      session: expect.objectContaining({ id: ID, state: 'working', project: 'meadow-hr' }), text: 'Fresh account: a@x.com / pw', replay: false,
    });
    expect(payloadOf('turn.finished')).toBeUndefined();
    expect(repo.get(ID)).toMatchObject({ state: 'working', turnStartedAt: '2026-10-09T12:00:00.000Z', claudeSessionId: 'claude-a' });
  });

  it('passes the replay flag through', () => {
    const { apply, payloadOf } = setup();
    apply(sessionStart('startup'), true);
    apply(prompt('x', { ts: '2026-10-09T11:00:00.000Z' }), true);
    apply(stop('y', { ts: '2026-10-09T11:00:30.000Z' }), true);
    expect(payloadOf('turn.finished')).toMatchObject({ replay: true, durationSec: 30 });
  });

  it('keeps one row across /clear and follows the new Claude id', () => {
    const { repo, apply } = setup();
    apply(sessionStart('startup', { session_id: 'claude-a' }));
    apply(question('QQQQ2345', [{ question: 'Which DB?', options: [{ label: 'Postgres' }] }]));
    apply(sessionStart('clear', { session_id: 'claude-b' }));
    apply(sessionEnd('clear', { session_id: 'claude-a' }));
    expect(repo.list()).toHaveLength(1);
    expect(repo.get(ID)).toMatchObject({ claudeSessionId: 'claude-b', pendingQid: 'QQQQ2345', state: 'waiting_question' });
  });

  it('treats the brain as a system session without memory rows', () => {
    const { repo, apply, messages } = setup();
    apply(sessionStart('startup', { tmux: 'manager:0.0' }), false, 'hq');
    apply(prompt('[Chat · Fri 12:00] hi', { tmux: 'manager:0.0' }), false, 'hq');
    apply(stop('Hello!', { tmux: 'manager:0.0' }), false, 'hq');
    expect(repo.get('hq:manager:0.0')?.origin).toBe('system');
    expect(messages()).toEqual([]);
  });

  it('ignores events without a tmux pane', () => {
    const { repo, seen, apply } = setup();
    apply(prompt('no pane', { tmux: null }));
    apply(stop('no pane', { tmux: 'not a target' }));
    expect(repo.list()).toEqual([]);
    expect(seen).toEqual([]);
  });
});
