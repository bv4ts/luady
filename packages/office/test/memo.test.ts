import { describe, expect, it } from 'vitest';
import { slotsFor } from '../src/desks.js';
import { buildOffice } from '../src/layout.js';
import { MEMO_LIMIT, createMemo } from '../src/memo.js';
import { desksFor, propsFor } from '../src/props.js';
import { buildSnapshot, type SnapshotInput } from '../src/snapshot.js';
import { ALL_SERVERS, NOW, luadyStatus, server, session } from './fixtures.js';
import { CLASSIC_ROOMS, classicRooms } from './rooms-fixture.js';

describe('createMemo', () => {
  it('makes a value once per key', () => {
    const memo = createMemo<{ n: number }>();
    let made = 0;
    const make = (): { n: number } => ({ n: (made += 1) });
    const a = memo.get('a', make);
    expect(memo.get('a', make)).toBe(a);
    expect(made).toBe(1);
  });

  it('holds at most MEMO_LIMIT entries, dropping the least recently used', () => {
    expect(MEMO_LIMIT).toBe(32);
    const memo = createMemo<string>();
    const made: string[] = [];
    const make = (key: string) => (): string => {
      made.push(key);
      return key;
    };
    Array.from({ length: 40 }, (_, i) => `k${i}`).forEach((k) => {
      memo.get(k, make(k));
      memo.get('k0', make('k0'));
    });
    expect(memo.size()).toBe(32);
    expect(made.filter((k) => k === 'k0')).toHaveLength(1);
    memo.get('k1', make('k1'));
    expect(made.filter((k) => k === 'k1')).toHaveLength(2);
  });
});

describe('stable identities', () => {
  it('returns the same map for the same servers, whatever the order and repeats', () => {
    expect(buildOffice(classicRooms(['birch', 'ash']))).toBe(buildOffice(classicRooms(['ash', 'birch', 'birch'])));
    expect(buildOffice(classicRooms(['birch']))).not.toBe(buildOffice(classicRooms(['birch', 'ash'])));
    expect(buildOffice(classicRooms([]))).toBe(buildOffice(classicRooms([])));
  });

  it('returns the same desk and furniture lists for the same inputs', () => {
    const map = buildOffice(classicRooms(['cedar', 'birch', 'ash', 'local']));
    expect(slotsFor(map.rooms.ash!, 'normal')).toBe(slotsFor(map.rooms.ash!, 'normal'));
    expect(slotsFor(map.rooms.ash!, 'tight')).not.toBe(slotsFor(map.rooms.ash!, 'normal'));
    expect(desksFor(map.rooms.ash!, 'normal', true)).toBe(desksFor(map.rooms.ash!, 'normal', true));
    expect(desksFor(map.rooms.ash!, 'normal', false)).toBe(slotsFor(map.rooms.ash!, 'normal'));
    expect(propsFor(map, { ash: true })).toBe(propsFor(map, { birch: false, ash: true }));
    expect(propsFor(map, { ash: true })).not.toBe(propsFor(map, {}));
  });

  it('keeps map, room definitions and unchanged desk and furniture lists across snapshots', () => {
    const input = (n: number): SnapshotInput => ({
      servers: ALL_SERVERS.map((s) => server(s.name)), rooms: CLASSIC_ROOMS, luady: luadyStatus(), now: NOW, questions: [], previousSeats: {},
      sessions: Array.from({ length: n }, (_, i) => session(`ash:s${String(i).padStart(2, '0')}`)),
    });
    const one = buildSnapshot(input(3));
    const two = buildSnapshot(input(3));
    expect(two.map).toBe(one.map);
    expect(two.rooms.birch?.def).toBe(one.rooms.birch?.def);
    expect(two.slots.ash).toBe(one.slots.ash);
    expect(two.props).toBe(one.props);
    const busy = buildSnapshot(input(9));
    expect(busy.slots.ash).not.toBe(one.slots.ash);
    expect(busy.props).not.toBe(one.props);
    expect(busy.slots.cedar).toBe(one.slots.cedar);
    expect(busy.map).toBe(one.map);
  });
});
