import { SELF_HOST_ID, managerName } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import {
  byOldest, chatNoticeIds, groupByHost, hostOrder, missions, needsYou, openNotices, pausedOf, pendingCount, questionFor, sessionLabel,
  toolsOf,
} from '../../src/state/selectors.js';
import { action, activityItem, notice, question, session } from '../fixtures.js';
import { roomDto } from '../room-fixtures.js';

/** Home rooms that put the classic hosts in the order cedar, birch, ash, local. */
const ROOMS = [
  roomDto({ id: 'meadow', host: 'cedar', position: 0 }), roomDto({ id: 'orchard', host: 'birch', position: 1 }),
  roomDto({ id: 'harbor', host: 'ash', position: 2 }), roomDto({ id: 'private', host: 'local', position: 3 }),
];

describe('live-activity selectors', () => {
  it('openNotices drops settled notices and the kinds the answer card owns', () => {
    const list = [
      notice({ id: 'a' }), notice({ id: 'b', settledAt: '2026-10-09T12:01:00.000Z', settledVia: 'web' }),
      notice({ id: 'c', kind: 'question' }), notice({ id: 'd', kind: 'permission' }), notice({ id: 'e', kind: 'reply' }),
    ];
    expect(openNotices(list).map((n) => n.id)).toEqual(['a', 'e']);
  });

  it('toolsOf and pausedOf read the slim records', () => {
    const activity = {
      a: activityItem({ sessionId: 'a', tool: 'run' }),
      b: activityItem({ sessionId: 'b', tool: null, paused: true }),
    };
    expect(toolsOf(activity)).toEqual({ a: 'run', b: null });
    expect([...pausedOf(activity)]).toEqual(['b']);
    expect(pausedOf({}).size).toBe(0);
  });
});

describe('selectors', () => {
  it('count pending items and flag sessions that need the owner', () => {
    expect(pendingCount({ questions: [question()], actions: [action(), action({ id: 'A8' })] })).toBe(3);
    expect(needsYou(session({ state: 'waiting_question' }))).toBe(true);
    expect(needsYou(session({ state: 'waiting_permission' }))).toBe(true);
    expect(needsYou(session({ state: 'working' }))).toBe(false);
    expect(sessionLabel(session())).toBe('cedar · meadow-hr');
  });

  it('group sessions by host in office order with urgent sessions first', () => {
    const sessions = [
      session({ id: 'ash:cc-harbor:0.0', host: 'ash', displayName: 'harbor' }),
      session({ id: 'cedar:cc-a:0.0', displayName: 'a', state: 'idle' }),
      session({ id: 'cedar:cc-b:0.0', displayName: 'b', state: 'waiting_question' }),
      session({ id: 'birch:cc-old:0.0', host: 'birch', displayName: 'old', state: 'ended' }),
    ];
    const groups = groupByHost(sessions, { includeEnded: false, rooms: ROOMS });
    expect(groups.map((g) => g.host)).toEqual(['cedar', 'ash']);
    expect(groups[0]?.sessions.map((s) => s.displayName)).toEqual(['b', 'a']);
    expect(groupByHost(sessions, { includeEnded: true, rooms: ROOMS }).map((g) => g.host)).toEqual(['cedar', 'birch', 'ash']);
  });

  it('orders hosts by their home room, hosts without a room by id after them, the manager\'s own host last', () => {
    const sessions = ['zeta', SELF_HOST_ID, 'ash', 'mars', 'cedar'].map((host) =>
      session({ id: `${host}:cc-x:0.0`, host, displayName: `x-${host}` }));
    expect(groupByHost(sessions, { includeEnded: false, rooms: ROOMS }).map((g) => g.host))
      .toEqual(['cedar', 'ash', 'mars', 'zeta', SELF_HOST_ID]);
    // No rooms: every host by id, the manager's own host still last.
    expect(groupByHost(sessions, { includeEnded: false }).map((g) => g.host)).toEqual(['ash', 'cedar', 'mars', 'zeta', SELF_HOST_ID]);
    // A project room does not place its host; the lowest home room does.
    const rooms = [roomDto({ id: 'web', kind: 'project', host: 'zeta', position: 0 }), roomDto({ id: 'm', host: 'mars', position: 9 })];
    expect(['zeta', 'mars', 'ash'].toSorted(hostOrder(rooms))).toEqual(['mars', 'ash', 'zeta']);
  });

  it('sessionLabel never prints the manager\'s own host id', () => {
    expect(sessionLabel(session({ host: SELF_HOST_ID, displayName: 'brief' }))).toBe(`${managerName()} HQ · brief`);
    expect(sessionLabel(session(), (host) => `room of ${host}`)).toBe('room of cedar · meadow-hr');
  });

  it('list only Luady missions', () => {
    const list = missions([session(), session({ id: 'birch:cc-m:0.0', origin: 'manager', displayName: 'm' })]);
    expect(list.map((s) => s.displayName)).toEqual(['m']);
  });

  it('find the pending question of a session', () => {
    const waiting = session({ state: 'waiting_question', pendingQid: 'ABCDEFGH' });
    expect(questionFor([question()], waiting)?.qid).toBe('ABCDEFGH');
    expect(questionFor([question()], session())).toBeUndefined();
  });

  it('sort by creation time, oldest first', () => {
    const items = [action({ id: 'A2', createdAt: '2026-10-09T12:05:00.000Z' }), action({ id: 'A1', createdAt: '2026-10-09T12:00:00.000Z' })];
    expect(byOldest(items).map((a) => a.id)).toEqual(['A1', 'A2']);
  });
});

describe('chatNoticeIds', () => {
  it('maps open notices about a Luady chat message to that message, and nothing else', () => {
    const items = [
      notice({ id: 'r1', kind: 'reply', ref: { kind: 'manager', id: 'm1' } }),
      notice({ id: 'r2', kind: 'result', ref: { kind: 'manager', id: 'm2' }, settledAt: '2026-10-09T12:01:00.000Z', settledVia: 'web' }),
      notice({ id: 'n3', kind: 'result', ref: { kind: 'session', id: 'cedar:cc-a:0.0' } }),
      notice({ id: 'q4', kind: 'question', ref: { kind: 'question', id: 'ABCDEFGH' } }),
    ];
    expect([...chatNoticeIds(items)]).toEqual([['m1', 'r1']]);
  });
});
