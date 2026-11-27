import { describe, expect, it } from 'vitest';
import type { SessionDTO } from '@luady/shared';
import { STRAIN_PCT, buildSnapshot, type SnapshotInput } from '../src/snapshot.js';
import { ALL_SERVERS, MINUTE, NOW, ago, luadyStatus, question, server, session, startingSession, sysinfo } from './fixtures.js';
import { classicRooms } from './rooms-fixture.js';

/** The input of a snapshot; its rooms are the classic rooms of its servers unless given. */
const input = (over: Partial<SnapshotInput> = {}): SnapshotInput => {
  const servers = over.servers ?? ALL_SERVERS;
  return {
    servers, rooms: classicRooms(servers.map((s) => s.name)), sessions: [], questions: [], luady: luadyStatus(), now: NOW, previousSeats: {}, ...over,
  };
};
const many = (host: string, n: number): SessionDTO[] => Array.from({ length: n }, (_, i) => session(`${host}:s${String(i).padStart(2, '0')}`));

describe('buildSnapshot: a normal day', () => {
  const sessions = [
    session('birch:a', { state: 'working' }),
    session('birch:b', { state: 'working' }),
    session('birch:c', { state: 'waiting_question', pendingQid: 'QQQQQQQQ' }),
    session('cedar:d', { state: 'idle', lastEventAt: ago(6 * MINUTE), project: 'fitness-demo' }),
    session('hq:e', { origin: 'system' }),
  ];
  const snap = buildSnapshot(input({ sessions, questions: [question('QQQQQQQQ', 'birch:c', ago(MINUTE))] }));

  it('puts the four room sessions on the map and leaves the system session out entirely', () => {
    expect(Object.keys(snap.actors).sort()).toEqual(['birch:a', 'birch:b', 'birch:c', 'cedar:d']);
    expect(snap.unplaced).toEqual([]);
  });

  it('dresses the cedar visitor as a sleeping guest', () => {
    const d = snap.actors['cedar:d'];
    expect(d?.look).toMatchObject({ guest: true, species: 'shield', palette: { base: '#12b886', accent: '#c3fae8' } });
    expect(d?.visual.pose).toBe('sleep');
    expect(d?.room).toBe('cedar');
  });

  it('counts who needs the owner', () => {
    expect(snap.rooms.birch?.needsOwner).toBe(1);
    expect(snap.rooms.cedar?.needsOwner).toBe(0);
    expect(snap.needs).toEqual(['birch:c']);
    expect(snap.actors['birch:c']?.qid).toBe('QQQQQQQQ');
  });

  it('sits every actor at its desk slot', () => {
    Object.values(snap.actors).forEach((a) => {
      const slot = snap.slots[a.room]?.[a.seat];
      expect(a.sit).toEqual(slot?.sit);
      expect(a.desk).toEqual(slot?.desk);
      expect(snap.seats[a.id]).toBe(a.seat);
    });
  });

  it('copies the session facts', () => {
    expect(snap.actors['birch:a']).toMatchObject({ name: 'name of birch:a', project: null, state: 'working', origin: 'owner', qid: null });
    expect(snap.actors['birch:a']?.visual).toEqual({ pose: 'type', bubble: 'dots', monitor: 'work', needsOwner: false });
  });

  it('lists every room of the map with its actors in desk order', () => {
    expect(Object.keys(snap.rooms).sort()).toEqual(['ash', 'birch', 'cedar', 'hq', 'local']);
    expect(snap.rooms.birch?.actors).toEqual(['birch:a', 'birch:b', 'birch:c']);
    expect(snap.rooms.birch?.mode).toBe('normal');
    expect(snap.rooms.hq).toMatchObject({ actors: [], overflow: [], needsOwner: 0, rack: null, mode: 'normal' });
    expect(snap.rooms.ash?.def.id).toBe('ash');
    expect(snap.slots.hq).toEqual([]);
    expect(snap.slots.birch).toHaveLength(12);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.actors)).toBe(true);
    expect(Object.isFrozen(snap.actors['birch:a'])).toBe(true);
    expect(Object.isFrozen(snap.rooms.birch)).toBe(true);
    expect(Object.isFrozen(snap.needs)).toBe(true);
  });
});

describe('buildSnapshot: sessions that do not get a desk', () => {
  it('lists a session on a host with no server row as unplaced, without throwing', () => {
    const snap = buildSnapshot(input({ servers: [server('birch'), server('cedar')], sessions: [session('ash:x'), session('birch:y')] }));
    expect(snap.unplaced).toEqual(['ash:x']);
    expect(Object.keys(snap.actors)).toEqual(['birch:y']);
    expect(Object.values(snap.rooms).some((r) => r.actors.includes('ash:x'))).toBe(false);
  });

  it('lists a non-system session on Luady host as unplaced', () => {
    const snap = buildSnapshot(input({ sessions: [session('hq:w', { origin: 'manager' }), session('hq:sys', { origin: 'system' })] }));
    expect(snap.unplaced).toEqual(['hq:w']);
    expect(snap.actors).toEqual({});
  });

  it('skips ended and unregistered sessions', () => {
    const snap = buildSnapshot(input({ sessions: [session('birch:gone', { state: 'ended' }), session('birch:raw', { registered: false }), session('ash:old', { state: 'ended' })], servers: [server('birch')] }));
    expect(snap.actors).toEqual({});
    expect(snap.unplaced).toEqual([]);
    expect(snap.seats).toEqual({});
  });

  it('lets a session that is just starting walk in before the kit registers it', () => {
    const row = startingSession('birch', 'fix-login');
    const snap = buildSnapshot(input({ sessions: [row] }));
    expect(snap.actors[row.id]).toMatchObject({ room: 'birch', name: 'fix-login', state: 'starting', seat: 0 });
    expect(snap.actors[row.id]?.visual.pose).toBe('walk');
  });

  it('lists a starting session on a host with no room as unplaced, and still skips a starting system session', () => {
    const snap = buildSnapshot(input({
      servers: [server('cedar')],
      sessions: [startingSession('ash', 'probe'), { ...startingSession('cedar', 'sys'), origin: 'system' }],
    }));
    expect(snap.unplaced).toEqual(['ash:luady-probe:0.0']);
    expect(snap.actors).toEqual({});
  });

  it('shows one actor for a repeated session id', () => {
    const snap = buildSnapshot(input({ sessions: [session('birch:a'), session('birch:a', { state: 'idle' })] }));
    expect(Object.keys(snap.actors)).toEqual(['birch:a']);
    expect(snap.actors['birch:a']?.state).toBe('working');
  });
});

describe('buildSnapshot: a crowded room', () => {
  it('seats 20 of 21 and reports one as overflow', () => {
    const snap = buildSnapshot(input({ sessions: many('birch', 21) }));
    expect(Object.keys(snap.actors)).toHaveLength(20);
    expect(snap.rooms.birch?.overflow).toHaveLength(1);
    expect(snap.rooms.birch?.mode).toBe('tight');
    expect(snap.slots.birch).toHaveLength(20);
    expect(new Set(Object.values(snap.actors).map((a) => a.seat)).size).toBe(20);
    expect(new Set(Object.values(snap.actors).map((a) => `${a.sit.x},${a.sit.y}`)).size).toBe(20);
  });

  it('clears the lounge of a tight room', () => {
    const snap = buildSnapshot(input({ sessions: many('cedar', 13) }));
    expect(snap.props.some((p) => p.room === 'cedar' && p.lounge)).toBe(false);
    expect(snap.props.some((p) => p.room === 'local' && p.lounge)).toBe(true);
  });

  it('keeps everyone else at their desk when one session leaves', () => {
    const sessions = many('birch', 5);
    const first = buildSnapshot(input({ sessions }));
    const second = buildSnapshot(input({ sessions: sessions.filter((s) => s.id !== 'birch:s02'), previousSeats: first.seats }));
    ['birch:s00', 'birch:s01', 'birch:s03', 'birch:s04'].forEach((id) => {
      expect(second.actors[id]?.seat).toBe(first.actors[id]?.seat);
      expect(second.actors[id]?.sit).toEqual(first.actors[id]?.sit);
    });
    expect(second.seats['birch:s02']).toBeUndefined();
  });
});

describe('buildSnapshot: seat memory', () => {
  const sessions = [session('birch:a'), session('birch:b'), session('birch:c')];
  const stored = { 'birch:a': 4, 'birch:b': 1 };

  it('puts everyone back on the original desk after a snapshot without server rows', () => {
    const first = buildSnapshot(input({ sessions, previousSeats: stored }));
    expect(first.seats).toEqual({ 'birch:a': 4, 'birch:b': 1, 'birch:c': 0 });
    const blind = buildSnapshot(input({ sessions, servers: [], previousSeats: first.seats }));
    expect(blind.actors).toEqual({});
    expect(blind.seats).toEqual(first.seats);
    const back = buildSnapshot(input({ sessions, previousSeats: blind.seats }));
    expect(back.seats).toEqual(first.seats);
    ['birch:a', 'birch:b', 'birch:c'].forEach((id) => expect(back.actors[id]?.sit).toEqual(first.actors[id]?.sit));
  });

  it('keeps the desk of a live session whose host has no server row', () => {
    const snap = buildSnapshot(input({ sessions: [session('ash:x'), session('birch:a')], servers: [server('birch')], previousSeats: { 'ash:x': 7, 'birch:a': 2 } }));
    expect(snap.seats).toEqual({ 'ash:x': 7, 'birch:a': 2 });
    expect(snap.unplaced).toEqual(['ash:x']);
  });

  it('forgets sessions that are gone or ended', () => {
    const snap = buildSnapshot(input({
      sessions: [session('birch:a'), session('ash:done', { state: 'ended' }), session('birch:done', { state: 'ended' })],
      servers: [server('birch')],
      previousSeats: { 'birch:a': 2, 'birch:gone': 3, 'ash:gone': 1, 'ash:done': 5, 'birch:done': 6 },
    }));
    expect(snap.seats).toEqual({ 'birch:a': 2 });
  });

  it('keeps nothing for a live session that had no desk before', () => {
    const snap = buildSnapshot(input({ sessions: [session('ash:x')], servers: [] }));
    expect(snap.seats).toEqual({});
  });
});

describe('buildSnapshot: racks', () => {
  const rackOf = (info: Parameters<typeof sysinfo>[0] | null, status: 'online' | 'offline' | 'connecting' = 'online') =>
    buildSnapshot(input({ servers: [server('birch', { status, sysinfo: info === null ? null : sysinfo(info) })] })).rooms.birch?.rack;

  it('scales load so 4 is full', () => {
    expect(rackOf({ load1: 2 })?.load).toBe(0.5);
    expect(rackOf({ load1: 4 })?.load).toBe(1);
    expect(rackOf({ load1: 9 })?.load).toBe(1);
    expect(rackOf({ load1: 0 })?.load).toBe(0);
  });

  it('calls memory tight below 15% free', () => {
    expect(rackOf({ mem_total_kb: 100, mem_avail_kb: 15 })?.memory).toBe('ok');
    expect(rackOf({ mem_total_kb: 100, mem_avail_kb: 14 })?.memory).toBe('tight');
    expect(rackOf({ mem_total_kb: 0, mem_avail_kb: 0 })?.memory).toBe('ok');
  });

  it('calls disk low below 10 GiB free', () => {
    expect(rackOf({ disk_free_kb: 10 * 1024 * 1024 })?.disk).toBe('ok');
    expect(rackOf({ disk_free_kb: 10 * 1024 * 1024 - 1 })?.disk).toBe('low');
  });

  it('passes the link status through and has no rack without numbers', () => {
    expect(rackOf({}, 'connecting')?.status).toBe('connecting');
    expect(rackOf(null, 'offline')).toBeNull();
  });

  it('keeps the link status of a server room even without numbers', () => {
    const snap = buildSnapshot(input({ servers: [server('birch', { status: 'offline', sysinfo: null }), server('ash', { status: 'connecting' })] }));
    expect(snap.rooms.birch?.status).toBe('offline');
    expect(snap.rooms.birch?.rack).toBeNull();
    expect(snap.rooms.ash?.status).toBe('connecting');
    expect(snap.rooms.hq?.status).toBeNull();
    expect(snap.rooms['lot-2']?.status).toBeNull();
  });

  it('gives lots and HQ no rack', () => {
    const snap = buildSnapshot(input({ servers: [server('birch')] }));
    expect(snap.rooms['lot-1']?.rack).toBeNull();
    expect(snap.rooms.hq?.rack).toBeNull();
  });
});

describe('buildSnapshot: what each actor shows', () => {
  it('shows the current tool', () => {
    const snap = buildSnapshot(input({ sessions: [session('birch:a')], tools: { 'birch:a': 'edit' } }));
    expect(snap.actors['birch:a']?.visual.bubble).toBe('pencil');
  });

  it('shows a pause', () => {
    const snap = buildSnapshot(input({ sessions: [session('birch:a')], paused: new Set(['birch:a']) }));
    expect(snap.actors['birch:a']?.visual.bubble).toBe('pause');
  });

  it('copes with a state string from a newer hub', () => {
    const odd = session('birch:a', { state: 'compacting' as SessionDTO['state'] });
    const snap = buildSnapshot(input({ sessions: [odd] }));
    expect(snap.actors['birch:a']?.visual).toEqual({ pose: 'sit', bubble: 'dots', monitor: 'off', needsOwner: false });
  });

  it('warns when a working session has taken no step for 10 minutes', () => {
    const snap = buildSnapshot(input({ sessions: [session('birch:a', { lastEventAt: ago(0) })], stepTimes: { 'birch:a': NOW - 10 * MINUTE } }));
    expect(snap.actors['birch:a']?.visual.bubble).toBe('ask');
  });

  it('does not warn about a long turn when it has no step times', () => {
    const snap = buildSnapshot(input({ sessions: [session('birch:a', { lastEventAt: ago(30 * MINUTE) })] }));
    expect(snap.actors['birch:a']?.visual.bubble).toBe('dots');
  });

  it('does not warn while steps keep coming, however old the last hub event is', () => {
    const snap = buildSnapshot(input({ sessions: [session('birch:a', { lastEventAt: ago(30 * MINUTE) })], stepTimes: { 'birch:a': NOW - MINUTE, 'birch:other': 0 } }));
    expect(snap.actors['birch:a']?.visual.bubble).toBe('dots');
  });

  it('treats a step time in the future or not a number as just now', () => {
    const snap = buildSnapshot(input({
      sessions: [session('birch:a'), session('birch:b')],
      stepTimes: { 'birch:a': NOW + 20 * MINUTE, 'birch:b': Number.NaN },
    }));
    expect(snap.actors['birch:a']?.visual.bubble).toBe('dots');
    expect(snap.actors['birch:b']?.visual.bubble).toBe('dots');
  });

  it('still lets an idle session doze off from its last hub event', () => {
    const snap = buildSnapshot(input({ sessions: [session('birch:a', { state: 'idle', lastEventAt: ago(6 * MINUTE) })], stepTimes: { 'birch:a': NOW } }));
    expect(snap.actors['birch:a']?.visual.pose).toBe('sleep');
  });

  it('treats a missing, broken or future event time as just now', () => {
    const snap = buildSnapshot(input({
      sessions: [
        session('birch:a', { state: 'idle', lastEventAt: null }),
        session('birch:b', { state: 'idle', lastEventAt: 'not a date' }),
        session('birch:c', { state: 'idle', lastEventAt: new Date(NOW + 60 * MINUTE).toISOString() }),
      ],
    }));
    ['birch:a', 'birch:b', 'birch:c'].forEach((id) => expect(snap.actors[id]?.visual.pose).toBe('sit'));
  });
});

describe('buildSnapshot: who needs the owner first', () => {
  it('orders by question age and puts unknown questions last', () => {
    const sessions = [
      session('birch:a', { state: 'waiting_question', pendingQid: 'AAAAAAAA' }),
      session('cedar:b', { state: 'waiting_permission', pendingQid: 'BBBBBBBB' }),
      session('ash:c', { state: 'waiting_question', pendingQid: 'CCCCCCCC' }),
      session('local:d', { state: 'waiting_question', pendingQid: null }),
    ];
    const questions = [
      question('AAAAAAAA', 'birch:a', ago(1 * MINUTE)),
      question('BBBBBBBB', 'cedar:b', ago(9 * MINUTE), { kind: 'permission' }),
      question('DDDDDDDD', 'local:d', ago(5 * MINUTE)),
    ];
    const snap = buildSnapshot(input({ sessions, questions }));
    expect(snap.needs).toEqual(['cedar:b', 'local:d', 'birch:a', 'ash:c']);
    expect(snap.rooms.cedar?.needsOwner).toBe(1);
  });
});

describe('buildSnapshot: waiting sessions without a desk', () => {
  it('counts an overflowed session that waits, in needs, in its room and as waiting elsewhere', () => {
    const crowd = many('birch', 21).map((s) => (s.id === 'birch:s20' ? { ...s, state: 'waiting_question' as const, pendingQid: 'ZZZZZZZZ' } : s));
    const snap = buildSnapshot(input({ sessions: crowd, questions: [question('ZZZZZZZZ', 'birch:s20', ago(MINUTE))] }));
    expect(snap.rooms.birch?.overflow).toEqual(['birch:s20']);
    expect(snap.actors['birch:s20']).toBeUndefined();
    expect(snap.needs).toEqual(['birch:s20']);
    expect(snap.rooms.birch?.needsOwner).toBe(1);
    expect(snap.waitingElsewhere).toEqual(['birch:s20']);
  });

  it('counts an unplaced session that waits, without giving any room its count', () => {
    const snap = buildSnapshot(input({
      servers: [server('birch')],
      sessions: [session('ash:x', { state: 'waiting_permission', pendingQid: 'XXXXXXXX' }), session('birch:y', { state: 'waiting_question', pendingQid: 'YYYYYYYY' })],
      questions: [question('XXXXXXXX', 'ash:x', ago(9 * MINUTE)), question('YYYYYYYY', 'birch:y', ago(2 * MINUTE))],
    }));
    expect(snap.needs).toEqual(['ash:x', 'birch:y']);
    expect(snap.waitingElsewhere).toEqual(['ash:x']);
    expect(snap.rooms.birch?.needsOwner).toBe(1);
    expect(Object.values(snap.rooms).reduce((n, r) => n + r.needsOwner, 0)).toBe(1);
  });

  it('leaves out system sessions, ended ones and the unregistered', () => {
    const snap = buildSnapshot(input({
      sessions: [
        session('hq:sys', { origin: 'system', state: 'waiting_question' }),
        session('birch:end', { state: 'ended' }),
        session('birch:raw', { registered: false, state: 'waiting_question' }),
      ],
    }));
    expect(snap.needs).toEqual([]);
    expect(snap.waitingElsewhere).toEqual([]);
  });

  it('has nobody waiting elsewhere when every waiting session has a desk', () => {
    const snap = buildSnapshot(input({ sessions: [session('birch:a', { state: 'waiting_question' })] }));
    expect(snap.needs).toEqual(['birch:a']);
    expect(snap.waitingElsewhere).toEqual([]);
    expect(Object.isFrozen(snap.waitingElsewhere)).toBe(true);
  });
});

describe('buildSnapshot: Luady', () => {
  it('is down when the hub has no status', () => {
    expect(buildSnapshot(input({ luady: null })).luady).toEqual({ state: 'down', queued: 0 });
  });

  it('keeps a manager switched off as off: a calm state of its own, not down', () => {
    expect(buildSnapshot(input({ luady: luadyStatus({ state: 'off', queued: 0 }) })).luady).toEqual({ state: 'off', queued: 0 });
  });

  it('copies the status', () => {
    expect(buildSnapshot(input({ luady: luadyStatus({ state: 'busy', queued: 2 }) })).luady).toEqual({ state: 'busy', queued: 2 });
  });
});

describe('buildSnapshot: inputs', () => {
  it('does not change what it was given', () => {
    const sessions = [session('birch:b'), session('birch:a')];
    const previousSeats = { 'birch:a': 3 };
    const servers = [server('birch')];
    buildSnapshot(input({ sessions, previousSeats, servers }));
    expect(sessions.map((s) => s.id)).toEqual(['birch:b', 'birch:a']);
    expect(previousSeats).toEqual({ 'birch:a': 3 });
    expect(servers.map((s) => s.name)).toEqual(['birch']);
  });

});

describe('buildSnapshot: helpers and strain', () => {
  const sessions = [session('birch:a'), session('birch:b'), session('cedar:c')];

  it('gives an actor its running helpers and everyone else 0', () => {
    const snap = buildSnapshot(input({ sessions, helpers: { 'birch:a': 2 } }));
    expect(snap.actors['birch:a']?.helpers).toBe(2);
    expect(snap.actors['birch:b']?.helpers).toBe(0);
    expect(buildSnapshot(input({ sessions })).actors['cedar:c']?.helpers).toBe(0);
  });

  it('ignores a helper count that is not a whole, non-negative number', () => {
    const snap = buildSnapshot(input({ sessions, helpers: { 'birch:a': -1, 'birch:b': Number.NaN } }));
    expect(snap.actors['birch:a']?.helpers).toBe(0);
    expect(snap.actors['birch:b']?.helpers).toBe(0);
  });

  it('marks an agent strained from 90% of its context window', () => {
    const snap = buildSnapshot(input({ sessions, contextPct: { 'birch:a': 89, 'birch:b': 90, 'cedar:c': null } }));
    expect(STRAIN_PCT).toBe(90);
    expect(snap.actors['birch:a']?.strained).toBe(false);
    expect(snap.actors['birch:b']?.strained).toBe(true);
    expect(snap.actors['cedar:c']?.strained).toBe(false);
  });

  it('carries each agent context reading for its monitor bar, null when there is none or it cannot be read', () => {
    const snap = buildSnapshot(input({ sessions, contextPct: { 'birch:a': 61, 'birch:b': 140, 'cedar:c': null } }));
    expect(snap.actors['birch:a']?.contextPct).toBe(61);
    expect(snap.actors['birch:b']?.contextPct).toBe(100);
    expect(snap.actors['cedar:c']?.contextPct).toBeNull();
    const none = buildSnapshot(input({ sessions, contextPct: { 'birch:a': Number.NaN } }));
    expect(none.actors['birch:a']?.contextPct).toBeNull();
    expect(none.actors['birch:b']?.contextPct).toBeNull();
  });
});

describe('buildSnapshot: fixtures', () => {
  it('lists the fixtures and gives each a prop of the same id', () => {
    const snap = buildSnapshot(input());
    expect(snap.fixtures.map((f) => f.id)).toEqual(['rack-birch', 'rack-ash', 'rack-cedar', 'rack-local', 'board-hq', 'library-hq', 'notes-hq', 'fuse-hq', 'clock-hq', 'schedule-hq', 'tv-hq', 'wins-hq', 'robot-hq', 'links-birch', 'links-ash', 'links-cedar', 'links-local']);
    snap.fixtures.forEach((f) => expect(snap.props.some((p) => p.id === f.id)).toBe(true));
  });

  it('hangs a Jira board in the rooms of jiraRooms that are on the map, as a fixture and as a prop', () => {
    const snap = buildSnapshot(input({ servers: ALL_SERVERS.filter((s) => s.name !== 'ash'), jiraRooms: ['birch', 'ash', 'hq'] }));
    expect(snap.fixtures.filter((f) => f.kind === 'jira')).toEqual([expect.objectContaining({ id: 'jira-birch', room: 'birch', label: 'Jira' })]);
    expect(snap.props.filter((p) => p.kind === 'jira').map((p) => p.id)).toEqual(['jira-birch']);
  });

  it('keeps the same fixture list from one snapshot to the next', () => {
    expect(buildSnapshot(input({ jiraRooms: ['cedar'] })).fixtures).toBe(buildSnapshot(input({ jiraRooms: ['cedar'], now: NOW + 1 })).fixtures);
  });
});
