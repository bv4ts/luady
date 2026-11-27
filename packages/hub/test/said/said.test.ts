import { describe, expect, it } from 'vitest';
import { SaidDTOSchema, type SaidDTO, type SessionDTO } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { createSaidService } from '../../src/said/index.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { makeSession } from '../board/harness.js';

function setup() {
  const bus = createBus();
  const sessions = new Map<string, SessionDTO>();
  const said = createSaidService({ bus, clock: createFakeClock('2026-11-15T09:00:00.000Z'), log: silentLogger(), sessions: { get: (id) => sessions.get(id) } });
  const heard: SaidDTO[] = [];
  bus.on('session.said', (item) => heard.push(item));
  said.start();
  const add = (session: SessionDTO): SessionDTO => {
    sessions.set(session.id, session);
    return session;
  };
  return { bus, said, heard, sessions, add };
}

describe('what agents said', () => {
  it('a finished turn and a report become session.said; the newest per session is kept for GET /api/said', () => {
    const t = setup();
    const session = t.add(makeSession({ state: 'idle' }));
    t.bus.emit('turn.finished', { session, durationSec: 30, remote: false, lastMessage: '  All tests pass.  ', replay: false });
    t.bus.emit('session.report', { session, text: 'The preview is live.', replay: false });
    expect(t.heard.map((item) => SaidDTOSchema.parse(item))).toEqual([
      { sessionId: session.id, kind: 'reply', text: 'All tests pass.', truncated: false, at: '2026-11-15T09:00:00.000Z' },
      { sessionId: session.id, kind: 'report', text: 'The preview is live.', truncated: false, at: '2026-11-15T09:00:00.000Z' },
    ]);
    expect(t.said.list()).toEqual([t.heard[1]]);
  });

  it('never for a replay, for Luady\'s own session, a system session or an empty message', () => {
    const t = setup();
    const session = t.add(makeSession());
    const luady = t.add(makeSession({ id: 'hq:manager:0.0', host: 'hq', origin: 'system', displayName: 'manager' }));
    const luadyOwner = t.add(makeSession({ id: 'hq:x:0.0', host: 'hq', origin: 'owner' }));
    t.bus.emit('turn.finished', { session, durationSec: 1, remote: false, lastMessage: 'old', replay: true });
    t.bus.emit('session.report', { session, text: 'old report', replay: true });
    t.bus.emit('turn.finished', { session: luady, durationSec: 1, remote: false, lastMessage: 'brain', replay: false });
    t.bus.emit('turn.finished', { session: luadyOwner, durationSec: 1, remote: false, lastMessage: 'brain', replay: false });
    t.bus.emit('turn.finished', { session, durationSec: 1, remote: false, lastMessage: '   ', replay: false });
    expect(t.heard).toEqual([]);
    expect(t.said.list()).toEqual([]);
  });

  it('cuts to 1,200 characters and says so', () => {
    const t = setup();
    const session = t.add(makeSession());
    t.bus.emit('turn.finished', { session, durationSec: 1, remote: false, lastMessage: 'é'.repeat(1300), replay: false });
    t.bus.emit('turn.finished', { session, durationSec: 1, remote: false, lastMessage: '😀'.repeat(700), replay: false });
    expect(t.heard[0]?.text).toHaveLength(1200);
    expect(t.heard[0]).toMatchObject({ truncated: true });
    expect(t.heard[0]?.text.endsWith('…')).toBe(true);
    expect(t.heard[1]?.text.length).toBeLessThanOrEqual(1200);
    expect(SaidDTOSchema.safeParse(t.heard[1]).success).toBe(true);
  });

  it('forgets a session when it ends or is removed', () => {
    const t = setup();
    const one = t.add(makeSession());
    const two = t.add(makeSession({ id: 'cedar:cc-two:0.0', host: 'cedar' }));
    for (const session of [one, two]) t.bus.emit('turn.finished', { session, durationSec: 1, remote: false, lastMessage: 'hi', replay: false });
    expect(t.said.list()).toHaveLength(2);
    t.bus.emit('session.ended', { session: { ...one, state: 'ended' }, unexpected: false, reason: 'stopped', replay: false });
    t.bus.emit('session.removed', { id: two.id });
    expect(t.said.list()).toEqual([]);
  });
});
