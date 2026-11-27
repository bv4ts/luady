import { describe, expect, it } from 'vitest';
import { gridFor, slotAt } from '@luady/shared/pure';
import {
  BAND_H, HQ_W, MARGIN, ROOM_H, ROOM_W, STREET_H, bandY, colX, geometryFor, roomRectOf, slotIndexAt, slotIndexOf, slotsMeeting,
  type Geometry,
} from '../src/grid.js';
import { CORRIDORS, EAST_X, ENTRIES, HQ_DOORS, HQ_MID, HQ_RECT, HQ_X } from '../src/rooms.js';
import type { TileRect } from '../src/types.js';

const meets = (a: TileRect, b: TileRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const geometryOfCount = (n: number): Geometry => {
  const grid = gridFor(n);
  return geometryFor(grid.K, grid.R);
};

describe('grid constants', () => {
  it('are a room 26 × 17, a street 6 tall, HQ 30 wide, a band of 40 and a margin of 1', () => {
    expect([ROOM_W, ROOM_H, STREET_H, HQ_W, BAND_H, MARGIN]).toEqual([26, 17, 6, 30, 40, 1]);
  });
});

describe('geometry at K = R = 1 is the classic office (rooms.ts, layout.ts)', () => {
  const g = geometryFor(1, 1);

  it('has the classic size, HQ, columns and doors', () => {
    expect([g.cols, g.rows, g.hqX, g.eastX, g.hqMid]).toEqual([84, 42, HQ_X, EAST_X, HQ_MID]);
    expect(g.hqRect).toEqual(HQ_RECT);
    expect(g.hqDoors).toEqual(HQ_DOORS);
    expect(g.building).toEqual({ x: 1, y: 1, w: 82, h: 40 });
  });

  it('puts slots 0-3 on the classic corners', () => {
    expect([0, 1, 2, 3].map((i) => roomRectOf(g, slotAt(i)))).toEqual([
      { x: 1, y: 1, w: 26, h: 17 }, { x: 57, y: 1, w: 26, h: 17 }, { x: 1, y: 24, w: 26, h: 17 }, { x: 57, y: 24, w: 26, h: 17 },
    ]);
  });

  it('has the classic two corridors and street doors, no avenue and no courts', () => {
    expect(g.streets.map((s) => s.rect)).toEqual(CORRIDORS);
    expect(g.streets.map((s) => s.kind)).toEqual(['west', 'east']);
    expect(g.streets.map((s) => s.wall)).toEqual([{ x: 1, y: 18, w: 1, h: 6 }, { x: 82, y: 18, w: 1, h: 6 }]);
    expect(g.streets.map((s) => s.hall)).toEqual([{ x: 2, y: 18, w: 25, h: 6 }, { x: 57, y: 18, w: 25, h: 6 }]);
    expect(g.entries).toEqual(ENTRIES);
    expect(g.entryTiles).toEqual([{ tx: 0, ty: 20 }, { tx: 83, ty: 21 }]);
    expect(g.avenue).toBeNull();
    expect(g.courts).toEqual([]);
  });
});

describe('geometry for any K and R', () => {
  it('follows the formulas', () => {
    const g = geometryFor(3, 2);
    expect(g.cols).toBe(2 * MARGIN + 2 * 3 * ROOM_W + HQ_W);
    expect(g.rows).toBe(2 * MARGIN + 2 * BAND_H);
    expect([g.hqX, g.eastX, g.hqMid]).toEqual([79, 109, 94]);
    expect([colX(g, 'west', 1), colX(g, 'west', 3), colX(g, 'east', 1), colX(g, 'east', 3)]).toEqual([53, 1, 109, 161]);
    expect([bandY(0), bandY(1), bandY(2)]).toEqual([1, 41, 81]);
    expect(g.hqRect).toEqual({ x: 79, y: 1, w: 30, h: 40 });
  });

  it('runs streets on every band, with a crossing below HQ from the second band on', () => {
    const g = geometryFor(2, 3);
    expect(g.streets.map((s) => [s.kind, s.row, s.rect])).toEqual([
      ['west', 0, { x: 1, y: 18, w: 52, h: 6 }], ['east', 0, { x: 83, y: 18, w: 52, h: 6 }],
      ['west', 1, { x: 1, y: 58, w: 52, h: 6 }], ['east', 1, { x: 83, y: 58, w: 52, h: 6 }], ['crossing', 1, { x: 53, y: 58, w: 30, h: 6 }],
      ['west', 2, { x: 1, y: 98, w: 52, h: 6 }], ['east', 2, { x: 83, y: 98, w: 52, h: 6 }], ['crossing', 2, { x: 53, y: 98, w: 30, h: 6 }],
      ['avenue', 1, { x: 65, y: 41, w: 6, h: 80 }],
    ]);
    expect(g.streets.filter((s) => s.kind === 'crossing').every((s) => s.wall === null)).toBe(true);
    expect(g.avenue).toEqual({ x: 65, y: 41, w: 6, h: 80 });
    expect(g.streets.at(-1)?.wall).toEqual({ x: 65, y: 120, w: 6, h: 1 });
  });

  it('opens HQ to the avenue through a south door when there is more than one band', () => {
    expect(geometryFor(2, 1).hqDoors).toHaveLength(2);
    expect(geometryFor(2, 2).hqDoors).toEqual([{ x: 53, y: 20, w: 1, h: 2 }, { x: 82, y: 20, w: 1, h: 2 }, { x: 67, y: 40, w: 2, h: 1 }]);
  });

  it('leaves 12 × 17 courts either side of the avenue, and enters west and east on every band, plus a south gate', () => {
    const g = geometryFor(2, 2);
    expect(g.courts).toEqual([{ x: 53, y: 41, w: 12, h: 17 }, { x: 71, y: 41, w: 12, h: 17 }, { x: 53, y: 64, w: 12, h: 17 }, { x: 71, y: 64, w: 12, h: 17 }]);
    expect(g.entries).toEqual([
      { x: 0, y: 20, w: 2, h: 2 }, { x: 134, y: 20, w: 2, h: 2 }, { x: 0, y: 60, w: 2, h: 2 }, { x: 134, y: 60, w: 2, h: 2 }, { x: 67, y: 80, w: 2, h: 2 },
    ]);
    expect(g.entryTiles).toEqual([{ tx: 0, ty: 20 }, { tx: 135, ty: 21 }, { tx: 0, ty: 60 }, { tx: 135, ty: 61 }, { tx: 67, ty: 81 }]);
  });

  it('keeps rooms, HQ, streets and courts apart, and everything inside the building', () => {
    [1, 4, 5, 9, 17, 25, 37, 100, 300].forEach((n) => {
      const g = geometryOfCount(n);
      const rooms = Array.from({ length: gridFor(n).capacity }, (_, i) => roomRectOf(g, slotAt(i)));
      const parts = [...rooms, g.hqRect, ...g.streets.filter((s) => s.kind !== 'avenue').map((s) => s.rect), ...g.courts];
      parts.forEach((a, i) => parts.slice(i + 1).forEach((b) => expect(meets(a, b)).toBe(false)));
      const inside = (r: TileRect): boolean => r.x >= g.building.x && r.y >= g.building.y && r.x + r.w <= g.building.x + g.building.w && r.y + r.h <= g.building.y + g.building.h;
      parts.forEach((r) => expect(inside(r)).toBe(true));
      const area = parts.reduce((sum, r) => sum + r.w * r.h, 0);
      const avenue = g.avenue === null ? 0 : g.avenue.w * (g.avenue.h - (g.R - 1) * STREET_H);
      expect(area + avenue).toBe(g.building.w * g.building.h);
    });
  });

  it('refuses a grid that is not whole and positive', () => {
    expect(() => geometryFor(0, 1)).toThrow(RangeError);
    expect(() => geometryFor(1, 1.5)).toThrow(RangeError);
  });

  it('gives the same frozen geometry for the same grid', () => {
    expect(geometryFor(4, 3)).toBe(geometryFor(4, 3));
    expect(Object.isFrozen(geometryFor(4, 3).streets)).toBe(true);
  });
});

describe('slotIndexOf: the inverse of slotAt', () => {
  it('finds every slot of the first 5,000 by its side, column, row and half', () => {
    for (let i = 0; i < 5000; i += 1) {
      const s = slotAt(i);
      expect(slotIndexOf(s.side, s.col, s.row, s.half)).toBe(i);
    }
  });

  it('refuses a column below 1 or a row below 0', () => {
    expect(() => slotIndexOf('west', 0, 0, 'north')).toThrow(RangeError);
    expect(() => slotIndexOf('east', 1, -1, 'south')).toThrow(RangeError);
  });
});

describe('slotIndexAt and slotsMeeting: rooms from tiles, by arithmetic', () => {
  it.each([1, 5, 24, 300])('agree with the room rectangles for %i slots', (n) => {
    const g = geometryOfCount(n);
    const capacity = gridFor(n).capacity;
    const rects = Array.from({ length: capacity }, (_, i) => roomRectOf(g, slotAt(i)));
    const step = n > 24 ? 7 : 1;
    for (let ty = -1; ty <= g.rows; ty += step) {
      for (let tx = -1; tx <= g.cols; tx += step) {
        const hit = rects.findIndex((r) => tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h);
        const inHq = tx >= g.hqX && tx < g.eastX && ty >= MARGIN && ty < MARGIN + BAND_H;
        expect([tx, ty, slotIndexAt(g, tx, ty)]).toEqual([tx, ty, inHq ? -2 : hit]);
      }
    }
    [{ x: 0, y: 0, w: 40, h: 30 }, { x: g.hqX - 3, y: 15, w: 40, h: 40 }, { x: 5, y: 5, w: 1, h: 1 }, { x: -9, y: -9, w: 3, h: 3 }].forEach((win) => {
      const want = rects.flatMap((r, i) => (meets(r, win) ? [i] : []));
      expect(slotsMeeting(g, win)).toEqual(want);
    });
  });
});
