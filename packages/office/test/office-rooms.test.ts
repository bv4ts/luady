import { describe, expect, it } from 'vitest';
import { gridFor } from '@luady/shared/pure';
import { OFFICE_MEMO_LIMIT, buildOffice, roomAtPx, roomRectPx, type OfficeMap } from '../src/layout.js';
import { HQ_ID, isEmptySlot, type RoomDef } from '../src/rooms.js';
import { CLASSIC_ROOMS, classic, room, rooms } from './rooms-fixture.js';

const overlaps = (a: RoomDef, b: RoomDef): boolean =>
  a.rect.x < b.rect.x + b.rect.w && b.rect.x < a.rect.x + a.rect.w && a.rect.y < b.rect.y + b.rect.h && b.rect.y < a.rect.y + a.rect.h;

const inside = (outer: { x: number; y: number; w: number; h: number }, r: { x: number; y: number; w: number; h: number }): boolean =>
  r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;

const defs = (map: OfficeMap): readonly RoomDef[] => map.order.map((key) => map.rooms[key]!);

describe('buildOffice from the classic RoomDTOs', () => {
  const map = buildOffice(CLASSIC_ROOMS);

  it('lays out the classic four in reading order, 1344 x 672', () => {
    expect(map.order).toEqual(['birch', 'ash', HQ_ID, 'cedar', 'local']);
    expect([map.width, map.height]).toEqual([1344, 672]);
  });

  it('carries the grid the hub reports, the chunk grid and no problems', () => {
    expect(map.grid).toEqual({ slotCount: 4, K: 1, R: 1, capacity: 4 });
    expect(map.chunks).toEqual({ origin: { x: -320, y: -320 }, size: 512, cols: 4, rows: 3 });
    expect(map.problems).toEqual([]);
  });

  it('gives each room its slot, orientation, host and palette', () => {
    expect(map.rooms.birch).toMatchObject({ kind: 'server', host: 'birch', orientation: 'west-north', palette: { base: '#d6336c', accent: '#74b816' } });
    expect(map.rooms.ash?.slot).toEqual({ index: 1, side: 'east', col: 1, row: 0, half: 'north' });
    expect(map.rooms.cedar?.orientation).toBe('west-south');
    expect(map.rooms.local).toMatchObject({ orientation: 'east-south', species: 'ghost', palette: { base: '#7c5cff', accent: '#ffd84d' } });
    expect(map.rooms[HQ_ID]).toMatchObject({ kind: 'hq', slot: null, orientation: null, palette: { base: '#3cc3b0', accent: '#ffd84d' } });
  });
});

describe('buildOffice for N rooms (the first ring; office-scale.test.ts goes beyond it)', () => {
  it.each([0, 1, 2, 3, 4])('N = %i: no overlaps, everything inside the building, lots exactly on the empty slots', (n) => {
    const map = buildOffice(rooms(n));
    const all = defs(map);
    all.forEach((a, i) => all.slice(i + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
    all.forEach((r) => expect(inside(map.zones.all, roomRectPx(r))).toBe(true));
    const lots = all.filter(isEmptySlot);
    expect(lots.map((r) => r.id)).toEqual(Array.from({ length: 4 - n }, (_, i) => `lot-${n + i}`));
    lots.forEach((lot) => expect(lot).toMatchObject({ kind: 'lot', host: null, palette: { base: '#6c7689', accent: '#8a93a5' } }));
    expect([map.width, map.height]).toEqual([1344, 672]);
    expect(map.order).toHaveLength(5);
    expect(map.order[2]).toBe(HQ_ID);
    expect(map.problems).toEqual([]);
  });

  it('keeps every room where it was when the next one is added', () => {
    const maps = [0, 1, 2, 3, 4].map((n) => buildOffice(rooms(n)));
    maps.slice(1).forEach((map, n) => {
      const hq = map.rooms[HQ_ID]!.rect;
      rooms(n).forEach((r) => {
        const before = maps[n]!.rooms[r.id]!.rect;
        const after = map.rooms[r.id]!.rect;
        expect({ dx: after.x - hq.x, dy: after.y - hq.y }).toEqual({ dx: before.x - maps[n]!.rooms[HQ_ID]!.rect.x, dy: before.y - maps[n]!.rooms[HQ_ID]!.rect.y });
      });
    });
  });

  it('N = 5: draws the fifth room in the second column, on the hub\'s grid', () => {
    const map = buildOffice(rooms(5));
    expect(map.grid).toEqual({ slotCount: 5, ...gridFor(5) });
    expect(map.grid).toMatchObject({ K: 2, R: 1, capacity: 8 });
    expect(map.rooms['site-04']).toMatchObject({ kind: 'project', orientation: 'west-north', slot: { index: 4, side: 'west', col: 2 } });
    expect(map.problems).toEqual([]);
    expect([map.width, map.height]).toEqual([2176, 672]);
  });

  it('sparse positions: rooms at 1-4 with slot 0 empty give slotCount 5, K = 2 and eight slots, lots at 0, 5, 6 and 7', () => {
    const map = buildOffice([1, 2, 3, 4].map((p) => room(`at-${p}`, p)));
    expect(map.grid).toEqual({ slotCount: 5, K: 2, R: 1, capacity: 8 });
    expect(map.grid).toEqual({ slotCount: 5, ...gridFor(5) });
    expect(map.order).toEqual(['lot-0', 'at-1', HQ_ID, 'at-2', 'at-3', 'at-4', 'lot-5', 'lot-6', 'lot-7']);
    expect(map.order.filter((k) => map.rooms[k]?.kind === 'lot')).toEqual(['lot-0', 'lot-5', 'lot-6', 'lot-7']);
    expect(map.problems).toEqual([]);
  });

  it('lays out a room by its position, whatever the input order', () => {
    const map = buildOffice([room('c', 3), room('a', 0)]);
    expect(map.order).toEqual(['a', 'lot-1', HQ_ID, 'lot-2', 'c']);
    expect(map.rooms.c?.orientation).toBe('east-south');
  });
});

describe('buildOffice: input it cannot use', () => {
  it('ignores unknown kinds, repeated ids and positions, reserved ids and bad positions, and says so', () => {
    const map = buildOffice([
      room('a', 0),
      room('b', 0),
      room('a', 1),
      room('odd', 2, { kind: 'garage' as 'project' }),
      room(HQ_ID, 2),
      room('lot-2', 2),
      room('neg', -1),
      room('half', 1.5),
      room('ok', 3),
    ]);
    expect(map.order).toEqual(['a', 'lot-1', HQ_ID, 'lot-2', 'ok']);
    expect(map.problems).toEqual([
      'room b repeats position 0: ignored',
      'room a repeats an id: ignored',
      'room odd has an unknown kind (garage): ignored',
      'room hq uses a reserved id: ignored',
      'room lot-2 uses a reserved id: ignored',
      'room neg has no valid position (-1): ignored',
      'room half has no valid position (1.5): ignored',
    ]);
  });

  it('draws a cat room with the cat creature, with nothing to report', () => {
    const map = buildOffice([room('kit', 0, { species: 'cat' })]);
    expect(map.rooms.kit?.species).toBe('cat');
    expect(map.problems).toEqual([]);
  });

  it('still draws a species from outside the schema as a bun', () => {
    const map = buildOffice([room('odd', 0, { species: 'dragon' as 'cat' })]);
    expect(map.rooms.odd?.species).toBe('bun');
  });

  it('does not change its input', () => {
    const input = [room('b', 1), room('a', 0)];
    buildOffice(input);
    expect(input.map((r) => r.id)).toEqual(['b', 'a']);
  });
});

describe('buildOffice: memo and layout key', () => {
  it('gives back the same map for the same rooms', () => {
    expect(buildOffice(rooms(3))).toBe(buildOffice(rooms(3)));
    expect(buildOffice([])).toBe(buildOffice([]));
  });

  it('keeps the layout key when only the looks change, and changes it with the geometry', () => {
    const plain = buildOffice(rooms(2));
    const recoloured = buildOffice(rooms(2).map((r, i) => (i === 0 ? { ...r, colour: '#d6336c', name: 'Renamed' } : r)));
    expect(recoloured).not.toBe(plain);
    expect(recoloured.layoutKey).toBe(plain.layoutKey);
    expect(recoloured.rooms['site-00']?.palette.base).toBe('#d6336c');
    expect(buildOffice(rooms(3)).layoutKey).not.toBe(plain.layoutKey);
    expect(buildOffice(rooms(2).map((r, i) => (i === 0 ? { ...r, kind: 'local' as const } : r))).layoutKey).not.toBe(plain.layoutKey);
    expect(buildOffice([room('x', 1)]).layoutKey).not.toBe(buildOffice([room('x', 2)]).layoutKey);
  });

  it('builds a new map when the host changes', () => {
    const one = buildOffice([room('x', 0, { host: 'birch' })]);
    const two = buildOffice([room('x', 0, { host: 'ash' })]);
    expect(two).not.toBe(one);
    expect(two.rooms.x?.host).toBe('ash');
  });

  it(`holds the last ${OFFICE_MEMO_LIMIT} layouts only`, () => {
    const first = buildOffice([room('memo-0', 0)]);
    Array.from({ length: OFFICE_MEMO_LIMIT }, (_, i) => buildOffice([room(`memo-${i + 1}`, 0)]));
    expect(buildOffice([room('memo-0', 0)])).not.toBe(first);
    expect(buildOffice([room('memo-0', 0)])).toEqual(first);
  });

  it('fills the empty slots of one room with lots', () => {
    expect(buildOffice([classic('birch')]).order).toEqual(['birch', 'lot-1', HQ_ID, 'lot-2', 'lot-3']);
  });
});

describe('roomAtPx', () => {
  const map = buildOffice([room('a', 0), room('d', 3)]);

  it('finds rooms, lots and HQ from the pixel', () => {
    expect(roomAtPx(map, 5 * 16, 5 * 16)).toBe('a');
    expect(roomAtPx(map, 64 * 16, 5 * 16)).toBe('lot-1');
    expect(roomAtPx(map, 10 * 16, 30 * 16)).toBe('lot-2');
    expect(roomAtPx(map, 64 * 16, 30 * 16)).toBe('d');
    expect(roomAtPx(map, 35 * 16, 20 * 16)).toBe(HQ_ID);
  });

  it('is null in the corridors and outside', () => {
    expect(roomAtPx(map, 10 * 16, 20 * 16)).toBeNull();
    expect(roomAtPx(map, 0, 0)).toBeNull();
    expect(roomAtPx(map, -5, 100)).toBeNull();
    expect(roomAtPx(map, 1344, 100)).toBeNull();
  });

  it('agrees with the room rectangles on every tile', () => {
    for (let ty = 0; ty < 42; ty += 1) {
      for (let tx = 0; tx < 84; tx += 1) {
        const hit = map.order.find((key) => {
          const q = roomRectPx(map.rooms[key]!);
          return tx * 16 >= q.x && tx * 16 < q.x + q.w && ty * 16 >= q.y && ty * 16 < q.y + q.h;
        }) ?? null;
        expect(roomAtPx(map, tx * 16 + 3, ty * 16 + 7)).toBe(hit);
      }
    }
  });
});
