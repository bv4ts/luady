import { describe, expect, it } from 'vitest';
import type { RoomDTO } from '@luady/shared';
import { gridFor, slotAt, slotsGenerated } from '@luady/shared/pure';
import { POSITION_LIMIT, buildOffice, roomAtPx, roomInSlot, roomRectPx, type OfficeMap } from '../src/layout.js';
import { HQ_ID, isEmptySlot, isFurnished, type RoomDef } from '../src/rooms.js';
import type { TileRect } from '../src/types.js';
import { room, rooms } from './rooms-fixture.js';

/** The office sizes in tiles: the number of rooms, then the width and height of the building. */
const SIZES: readonly (readonly [number, number, number])[] = [
  [0, 84, 42], [1, 84, 42], [4, 84, 42], [5, 136, 42], [24, 188, 82], [100, 292, 202], [300, 500, 362],
];

const meets = (a: TileRect, b: TileRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const defs = (map: OfficeMap): readonly RoomDef[] => map.order.map((key) => map.rooms[key]!);

describe.each(SIZES)('buildOffice with %i rooms', (n, cols, rows) => {
  const map = buildOffice(rooms(n));
  const all = defs(map);

  it(`is ${cols} × ${rows} tiles, on the hub's grid`, () => {
    expect([map.width / 16, map.height / 16]).toEqual([cols, rows]);
    expect(map.grid).toEqual({ slotCount: n, ...gridFor(n) });
    expect(map.chunks).toMatchObject({ cols: Math.ceil((map.width + 640) / 512), rows: Math.ceil((map.height + 640) / 512) });
    expect(map.problems).toEqual([]);
  });

  it('places every room once, never two on one rectangle, all inside the building', () => {
    expect(all.filter(isFurnished).map((r) => r.id)).toEqual(rooms(n).map((r) => r.id));
    all.forEach((a, i) => all.slice(i + 1).forEach((b) => {
      if (meets(a.rect, b.rect)) throw new Error(`${a.id} meets ${b.id}`);
    }));
    const inside = map.zones.all;
    all.forEach((r) => {
      const q = roomRectPx(r);
      expect(q.x >= inside.x && q.y >= inside.y && q.x + q.w <= inside.x + inside.w && q.y + q.h <= inside.y + inside.h).toBe(true);
    });
  });

  it('fills every other slot of the grid with a lot, and orders slot 0, slot 1, HQ, then the rest', () => {
    const lots = all.filter(isEmptySlot);
    expect(lots.map((l) => l.slot?.index)).toEqual(Array.from({ length: map.grid.capacity - n }, (_, i) => n + i));
    lots.forEach((lot) => expect(lot.id).toBe(`lot-${lot.slot?.index}`));
    expect(map.order).toHaveLength(map.grid.capacity + 1);
    expect(map.order[2]).toBe(HQ_ID);
    all.filter((r) => r.slot !== null).forEach((r) => {
      expect(r.slot).toEqual(slotAt(r.slot!.index));
      expect(roomInSlot(map, r.slot!.index)).toBe(r);
    });
  });

  it('finds every room under its own pixels', () => {
    all.forEach((r) => {
      const q = roomRectPx(r);
      expect(roomAtPx(map, q.x + 3, q.y + 3)).toBe(r.id);
      expect(roomAtPx(map, q.x + q.w - 1, q.y + q.h - 1)).toBe(r.id);
    });
  });
});

describe('stability: adding a room never moves another one relative to HQ', () => {
  it('holds for every n from 0 to 299', () => {
    const relative = (map: OfficeMap, id: string): TileRect => {
      const hq = map.rooms[HQ_ID]!.rect;
      const r = map.rooms[id]!.rect;
      return { x: r.x - hq.x, y: r.y - hq.y, w: r.w, h: r.h };
    };
    let before = buildOffice(rooms(0));
    for (let n = 0; n < 300; n += 1) {
      const after = buildOffice(rooms(n + 1));
      rooms(n).forEach((r) => {
        const a = relative(before, r.id);
        const b = relative(after, r.id);
        if (a.x !== b.x || a.y !== b.y) throw new Error(`room ${r.id} moved when room ${n} came`);
      });
      before = after;
    }
  });
});

describe('sparse positions', () => {
  it('give the grid the hub reports: rooms at 1-4 with slot 0 empty are slotCount 5, K = 2, eight slots', () => {
    const map = buildOffice([1, 2, 3, 4].map((p) => room(`at-${p}`, p)));
    expect(map.grid).toEqual({ slotCount: 5, ...gridFor(5) });
    expect(map.grid).toEqual({ slotCount: 5, K: 2, R: 1, capacity: 8 });
    expect(defs(map).filter(isEmptySlot).map((r) => r.slot?.index)).toEqual([0, 5, 6, 7]);
  });

  it('lay one room far out with lots up to the capacity of its grid', () => {
    const map = buildOffice([room('far', 299)]);
    expect(map.grid).toEqual({ slotCount: 300, K: 9, R: 9, capacity: 324 });
    expect(defs(map).filter(isEmptySlot)).toHaveLength(323);
    expect(map.rooms.far?.slot).toEqual(slotAt(299));
  });
});

describe('the position sanity bound', () => {
  it(`refuses a position from ${POSITION_LIMIT} on, with a line, without laying out its slots`, () => {
    const before = slotsGenerated();
    const input: RoomDTO[] = [room('ok', 2), room('stray', POSITION_LIMIT), room('huge', Number.MAX_SAFE_INTEGER), room('big', 1e9)];
    const map = buildOffice(input);
    expect(map.problems).toEqual([
      `room stray has position ${POSITION_LIMIT}, beyond the last the office lays out (${POSITION_LIMIT - 1}): ignored`,
      `room huge has position ${Number.MAX_SAFE_INTEGER}, beyond the last the office lays out (${POSITION_LIMIT - 1}): ignored`,
      'room big has position 1000000000, beyond the last the office lays out (99999): ignored',
    ]);
    expect(map.grid).toEqual({ slotCount: 3, K: 1, R: 1, capacity: 4 });
    expect(slotsGenerated() - before).toBeLessThan(400);
  });
});
