import { describe, expect, it } from 'vitest';
import type { QuestionDTO, RoomDTO, ServerDTO, SessionDTO } from '@luady/shared';
import { buildRoomIndex, roomOf } from '@luady/shared/pure';
import { buildSnapshot, type AgencySnapshot, type SnapshotInput } from '../src/snapshot.js';
import { NOW, ago, luadyStatus, question, server, session } from './fixtures.js';
import { room } from './rooms-fixture.js';

/**
 * The snapshot at scale: 300 rooms on 100 hosts with 1,000 sessions. Every input object is wrapped
 * in a proxy that counts the reads of its fields, so the test can say how often each session and each room was looked
 * at: a bounded number of times each, growing with the input, never with rooms × sessions.
 */

interface Office { readonly rooms: readonly RoomDTO[]; readonly servers: readonly ServerDTO[]; readonly sessions: readonly SessionDTO[]; readonly questions: readonly QuestionDTO[] }

/** `hosts` hosts, each with a server room and two project rooms; `perHost` sessions on each host, every 7th waiting. */
const office = (hosts: number, perHost: number): Office => {
  const ids = Array.from({ length: hosts }, (_, h) => `host-${h}`);
  const rooms = ids.flatMap((host, h) => [
    room(`srv-${h}`, h * 3, { kind: 'server', host, match: [{ by: 'name', glob: `home-${h}*` }] }),
    room(`prj-${h}-a`, h * 3 + 1, { kind: 'project', host, match: [{ by: 'name', glob: `app-${h}-a*` }] }),
    room(`prj-${h}-b`, h * 3 + 2, { kind: 'project', host, match: [{ by: 'path', glob: `/srv/app-${h}-b/**` }] }),
  ]);
  const projects = (h: number, k: number): Pick<SessionDTO, 'project' | 'cwd'> => {
    switch (k % 5) {
      case 0: return { project: `app-${h}-a${k}`, cwd: null };
      case 1: return { project: `app-${h}-b`, cwd: `/srv/app-${h}-b/src` };
      case 2: return { project: `home-${h}-x`, cwd: null };
      case 3: return { project: `stray-${k}`, cwd: null };
      default: return { project: null, cwd: null };
    }
  };
  const sessions = ids.flatMap((host, h) => Array.from({ length: perHost }, (_, k) => session(`${host}:s${String(k).padStart(3, '0')}`, {
    ...projects(h, k), state: (h * perHost + k) % 7 === 0 ? 'waiting_question' : 'working', pendingQid: (h * perHost + k) % 7 === 0 ? `q-${h}-${k}` : null,
  })));
  const questions = sessions.filter((s) => s.pendingQid !== null).map((s, i) => question(s.pendingQid ?? '', s.id, ago(i * 1000)));
  return { rooms, servers: ids.map((id) => server(id)), sessions, questions };
};

/** Wraps every object in a read-counting proxy; `reads(o)` is how often the original's fields were read. */
const counting = <T extends object>(items: readonly T[]): { readonly items: readonly T[]; readonly reads: (i: number) => number } => {
  const counts = items.map(() => 0);
  const wrapped = items.map((item, i) => new Proxy(item, {
    get: (target, key, receiver) => {
      counts[i] = (counts[i] ?? 0) + 1;
      return Reflect.get(target, key, receiver) as unknown;
    },
  }));
  return { items: wrapped, reads: (i) => counts[i] ?? 0 };
};

const inputOf = (o: Office): SnapshotInput => ({
  servers: o.servers, rooms: o.rooms, sessions: o.sessions, questions: o.questions,
  luady: luadyStatus(), now: NOW, previousSeats: {},
});

interface Count { readonly session: readonly number[]; readonly room: readonly number[]; readonly question: readonly number[]; readonly server: readonly number[] }

const countReads = (o: Office): Count => {
  const sessions = counting(o.sessions);
  const rooms = counting(o.rooms);
  const questions = counting(o.questions);
  const servers = counting(o.servers);
  buildSnapshot(inputOf({ rooms: rooms.items, sessions: sessions.items, questions: questions.items, servers: servers.items }));
  const all = (n: number, reads: (i: number) => number): readonly number[] => Array.from({ length: n }, (_, i) => reads(i));
  return {
    session: all(o.sessions.length, sessions.reads), room: all(o.rooms.length, rooms.reads),
    question: all(o.questions.length, questions.reads), server: all(o.servers.length, servers.reads),
  };
};

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

describe('buildSnapshot at 300 rooms, 100 hosts and 1,000 sessions', () => {
  const big = office(100, 10);
  const counts = countReads(big);

  it('places every session it can, in its room', () => {
    const snap = buildSnapshot(inputOf(big));
    expect(Object.keys(snap.rooms)).toHaveLength(325);
    expect(Object.keys(snap.actors).length + snap.unplaced.length + Object.values(snap.rooms).reduce((n, r) => n + r.overflow.length, 0)).toBe(1000);
    expect(snap.unplaced).toEqual([]);
    expect(snap.needs.length).toBe(big.sessions.filter((s) => s.state === 'waiting_question').length);
  });

  it('reads each session, question and server a bounded number of times', () => {
    expect(Math.max(...counts.session)).toBeLessThanOrEqual(60);
    expect(Math.max(...counts.question)).toBeLessThanOrEqual(12);
    expect(Math.max(...counts.server)).toBeLessThanOrEqual(12);
  });

  it('reads each room a bounded number of times plus a few per session on its own host, never per session of the office', () => {
    const perHost = 10;
    counts.room.forEach((n) => expect(n).toBeLessThanOrEqual(80 + 8 * perHost));
    expect(sum(counts.room)).toBeLessThan(300 * 1000);
  });

  it('grows linearly: twice the office costs about twice the reads', () => {
    const half = countReads(office(50, 10));
    const total = (c: Count): number => sum(c.session) + sum(c.room) + sum(c.question) + sum(c.server);
    expect(total(counts) / total(half)).toBeLessThan(2.2);
    expect(total(counts)).toBeLessThan(100 * (300 + 1000 + 100));
  });
});

/** The room views worked out the slow way: for each room, filter every session and actor. */
const naiveRooms = (snap: AgencySnapshot, input: SnapshotInput): Readonly<Record<string, unknown>> => {
  const ix = buildRoomIndex(input.rooms ?? []);
  const live = input.sessions.filter((s) => s.origin !== 'system' && s.state !== 'ended' && (s.registered || s.state === 'starting'));
  const needs = new Set(snap.needs);
  return Object.fromEntries(snap.map.order.map((key) => {
    const def = snap.map.rooms[key]!;
    const placed = live.filter((s) => roomOf({ host: s.host, project: s.project, cwd: s.cwd }, ix)?.room === key);
    const actors = Object.values(snap.actors).filter((a) => a.room === key).toSorted((a, b) => a.seat - b.seat).map((a) => a.id);
    const seated = new Set(actors);
    const server = def.host === null ? undefined : input.servers.find((s) => s.name === def.host);
    return [key, {
      actors, overflow: placed.map((s) => s.id).filter((id) => !seated.has(id)).toSorted(),
      needsOwner: placed.filter((s) => needs.has(s.id)).length,
      status: ['server', 'project', 'local'].includes(def.kind) ? (server?.status ?? null) : null,
    }];
  }));
};

describe('the grouped snapshot equals a naive per-room filter', () => {
  it('on a 24-room sample (8 hosts, 3 rooms each, 70 sessions a host: some rooms overflow)', () => {
    const sample = office(8, 70);
    const input = inputOf(sample);
    const snap = buildSnapshot(input);
    const fast = Object.fromEntries(Object.entries(snap.rooms).map(([key, r]) => [key, { actors: r.actors, overflow: r.overflow, needsOwner: r.needsOwner, status: r.status }]));
    expect(fast).toEqual(naiveRooms(snap, input));
    expect(Object.values(snap.rooms).some((r) => r.overflow.length > 0)).toBe(true);
    expect(Object.values(snap.rooms).some((r) => r.needsOwner > 0)).toBe(true);
  });
});
