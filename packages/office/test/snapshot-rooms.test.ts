import { describe, expect, it } from 'vitest';
import type { RoomDTO, SessionDTO } from '@luady/shared';
import { HQ_ID } from '../src/rooms.js';
import { buildSnapshot, type SnapshotInput } from '../src/snapshot.js';
import { ALL_SERVERS, NOW, luadyStatus, question, server, session, sysinfo } from './fixtures.js';
import { CLASSIC_ROOMS, classic, room } from './rooms-fixture.js';

const input = (over: Partial<SnapshotInput> = {}): SnapshotInput => ({
  servers: ALL_SERVERS, rooms: CLASSIC_ROOMS, sessions: [], questions: [], luady: luadyStatus(), now: NOW, previousSeats: {}, ...over,
});

const DAY: SessionDTO[] = [
  session('birch:a', { state: 'working' }),
  session('birch:b', { state: 'waiting_question', pendingQid: 'QQQQQQQQ' }),
  session('cedar:c', { state: 'idle', project: 'fitness-demo' }),
  session('ash:d', { project: 'harbor-web' }),
  session('local:e', { project: 'anything' }),
  session('mars:f'),
  session('hq:g', { origin: 'system' }),
];

describe('buildSnapshot with the classic rooms', () => {
  const questions = [question('QQQQQQQQ', 'birch:b', new Date(NOW - 60_000).toISOString())];
  const viaRooms = buildSnapshot(input({ rooms: CLASSIC_ROOMS, sessions: DAY, questions, jiraRooms: ['ash'] }));

  it('places sessions through roomOf and keeps the rest unplaced', () => {
    expect(Object.keys(viaRooms.actors).sort()).toEqual(['ash:d', 'birch:a', 'birch:b', 'cedar:c', 'local:e']);
    expect(viaRooms.unplaced).toEqual(['mars:f']);
    expect(viaRooms.actors['cedar:c']?.look).toMatchObject({ guest: true, species: 'shield', palette: { base: '#12b886' } });
    expect(viaRooms.actors['ash:d']?.look.guest).toBe(false);
    expect(viaRooms.actors['birch:a']?.look.guest).toBe(false);
  });

  it('gives each room view its host', () => {
    expect(viaRooms.rooms.birch?.host).toBe('birch');
    expect(viaRooms.rooms[HQ_ID]?.host).toBeNull();
    expect(viaRooms.fixtures.filter((f) => f.kind === 'jira').map((f) => f.id)).toEqual(['jira-ash']);
  });
});

describe('buildSnapshot with rooms of every kind', () => {
  const rooms: RoomDTO[] = [
    classic('birch'),
    room('shop', 1, { kind: 'project', host: 'birch', match: [{ by: 'name', glob: 'shop-*' }], name: 'Shop', colour: '#3d7bff' }),
    room('docs', 2, { kind: 'project', host: null, match: [{ by: 'name', glob: 'docs*' }] }),
    room('lab', 3, { kind: 'local', host: 'computer', colour: '#2b8a3e', accent: '#a9e34b', species: 'ghost' }),
  ];
  const sessions = [
    session('birch:a', { project: 'shop-api' }),
    session('birch:b', { project: 'orchard' }),
    session('ash:c', { project: 'docs-site' }),
    session('computer:d'),
    session('ash:e'),
  ];
  const servers = [server('birch'), server('ash', { status: 'offline' }), server('computer', { sysinfo: sysinfo({ load1: 2 }) })];
  const snap = buildSnapshot(input({ rooms, sessions, servers }));

  it('places each session in the room roomOf names', () => {
    expect(snap.actors['birch:a']?.room).toBe('shop');
    expect(snap.actors['birch:b']?.room).toBe('birch');
    expect(snap.actors['ash:c']?.room).toBe('docs');
    expect(snap.actors['computer:d']?.room).toBe('lab');
    expect(snap.unplaced).toEqual(['ash:e']);
  });

  it('dresses each creature in its room palette', () => {
    expect(snap.actors['birch:a']?.look).toMatchObject({ species: 'bot', palette: { base: '#3d7bff' }, guest: false });
    expect(snap.actors['computer:d']?.look).toMatchObject({ species: 'ghost', palette: { base: '#2b8a3e', accent: '#a9e34b' } });
  });

  it('shows the rack of the room host, and a dark rack for a room of any host', () => {
    expect(snap.rooms.shop).toMatchObject({ host: 'birch', status: 'online' });
    expect(snap.rooms.shop?.rack).not.toBeNull();
    expect(snap.rooms.docs).toMatchObject({ host: null, rack: null, status: null });
    expect(snap.rooms.lab?.rack?.load).toBe(0.5);
  });

  it('gives every furnished room desks, a rack and a links board', () => {
    expect(snap.slots.birch).toHaveLength(12);
    expect(snap.slots.docs).toHaveLength(8);
    expect(snap.rooms.docs?.lounge).toBe(true);
    expect(snap.fixtures.filter((f) => f.kind === 'rack').map((f) => f.room)).toEqual(['birch', 'shop', 'docs', 'lab']);
  });
});

describe('guests, as roomOf decides them', () => {
  const rooms = [room('shop', 0, { kind: 'server', host: 'birch', match: [{ by: 'name', glob: 'shop*' }, { by: 'path', glob: '/srv/shop/**' }] })];
  const guest = (over: Partial<SessionDTO>): boolean | undefined =>
    buildSnapshot(input({ rooms, sessions: [session('birch:a', over)] })).actors['birch:a']?.look.guest;

  it('a session without a project or folder is at home: nothing could be compared', () => {
    expect(guest({ project: null, cwd: null })).toBe(false);
  });

  it('a session whose project or folder fits a match is at home, one that fits none is a guest', () => {
    expect(guest({ project: 'shop-api', cwd: null })).toBe(false);
    expect(guest({ project: null, cwd: '/srv/shop/api' })).toBe(false);
    expect(guest({ project: 'docs', cwd: null })).toBe(true);
    expect(guest({ project: null, cwd: '/srv/other' })).toBe(true);
  });
});

describe('buildSnapshot with rooms beyond the first ring and with none', () => {
  it('seats a session in a room beyond the first ring', () => {
    const snap = buildSnapshot(input({ rooms: [classic('birch'), room('far', 6, { kind: 'server', host: 'ash' })], sessions: [session('ash:x'), session('birch:y')] }));
    expect(snap.unplaced).toEqual([]);
    expect(Object.keys(snap.actors).toSorted()).toEqual(['ash:x', 'birch:y']);
    expect(snap.actors['ash:x']?.room).toBe('far');
    expect(snap.map.problems).toEqual([]);
    expect(snap.map.rooms.far?.slot).toMatchObject({ index: 6, side: 'west', col: 2, half: 'south' });
  });

  it('has HQ and four lots with no rooms', () => {
    const snap = buildSnapshot(input({ rooms: [], sessions: [session('birch:a')] }));
    expect(snap.map.order).toEqual(['lot-0', 'lot-1', HQ_ID, 'lot-2', 'lot-3']);
    expect(snap.unplaced).toEqual(['birch:a']);
    expect(snap.rooms['lot-1']).toMatchObject({ host: null, rack: null, status: null, actors: [] });
  });
});

describe('buildSnapshot: grouping once', () => {
  it('reads each session a fixed number of times: the work grows with the sessions, not sessions × rooms', () => {
    let reads = 0;
    const counted = (s: SessionDTO): SessionDTO => new Proxy(s, { get: (target, key, receiver) => {
      reads += 1;
      return Reflect.get(target, key, receiver);
    } });
    const hosts = ['birch', 'ash', 'cedar', 'local'];
    const crowd = (n: number): SessionDTO[] =>
      Array.from({ length: n }, (_, i) => counted(session(`${hosts[i % 4] ?? 'birch'}:s${String(i).padStart(2, '0')}`)));
    const readsFor = (n: number): number => {
      const sessions = crowd(n);
      reads = 0;
      buildSnapshot(input({ rooms: CLASSIC_ROOMS, sessions }));
      return reads;
    };
    const few = readsFor(8);
    const many = readsFor(40);
    expect(many / 40).toBeCloseTo(few / 8, 0);
    expect(many / 40).toBeLessThan(60);
  });
});
