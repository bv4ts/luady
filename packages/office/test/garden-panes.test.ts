import { describe, expect, it } from 'vitest';
import { CLASSIC_ROOMS, classicRooms } from './rooms-fixture.js';
import { MARGIN, geometryOf } from '../src/grid.js';
import { buildOffice } from '../src/layout.js';
import { HQ_ID, isFurnished } from '../src/rooms.js';
import { EXTERIOR_MARGIN, gardenLayout, lampFeet } from '../src/sprites/exterior.js';
import { panesOf } from '../src/sprites/panes.js';
import type { PixelRect } from '../src/types.js';
import { rooms } from './rooms-fixture.js';

const SIZES = [0, 1, 4, 5, 24, 100, 300] as const;
const T = 16;
const meets = (a: PixelRect, b: PixelRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const within = (inner: PixelRect, outer: PixelRect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

describe.each(SIZES)('panes of an office of %i rooms', (n) => {
  const map = buildOffice(rooms(n));
  const g = geometryOf(map);
  const panes = panesOf(map);

  it('sit only in the outer walls: the west and east walls, the south wall, and HQ\'s south wall', () => {
    const west = { x: MARGIN * T, y: 0, w: T, h: map.height };
    const east = { x: (g.cols - MARGIN - 1) * T, y: 0, w: T, h: map.height };
    const south = { x: 0, y: (g.rows - MARGIN - 1) * T, w: map.width, h: T };
    const hqSouth = { x: g.hqX * T, y: (MARGIN + 39) * T, w: g.hqRect.w * T, h: T };
    panes.forEach(({ glass, side, room }) => {
      if (side === 'west') expect(within(glass, west)).toBe(true);
      if (side === 'east') expect(within(glass, east)).toBe(true);
      if (side === 'south') expect(within(glass, room === HQ_ID ? hqSouth : south)).toBe(true);
    });
  });

  it('light every room on the outside: side panes in the outer column, south panes along the last band', () => {
    map.order.map((k) => map.rooms[k]!).filter(isFurnished).forEach((room) => {
      const mine = panes.filter((p) => p.room === room.id);
      const outer = room.slot!.col === g.K;
      const bottom = room.slot!.row === g.R - 1 && room.slot!.half === 'south';
      expect(mine.filter((p) => p.side !== 'south')).toHaveLength(outer ? 3 : 0);
      expect(mine.filter((p) => p.side === 'south')).toHaveLength(bottom ? 4 : 0);
    });
    expect(panes.filter((p) => p.room === HQ_ID)).toHaveLength(4);
  });
});

describe.each(SIZES)('the garden of an office of %i rooms (garden pieces at large K)', (n) => {
  const map = buildOffice(rooms(n));
  const { paths, pieces } = gardenLayout(map);
  const picture = { x: 0, y: 0, w: map.width + EXTERIOR_MARGIN * 2, h: map.height + EXTERIOR_MARGIN * 2 };
  const building = { x: map.zones.all.x + EXTERIOR_MARGIN, y: map.zones.all.y + EXTERIOR_MARGIN, w: map.zones.all.w, h: map.zones.all.h };

  it('never puts a bed, the pond, the bench or the bike rack on a path, on another piece, or on the building', () => {
    pieces.forEach((piece, i) => {
      paths.forEach((path) => expect(meets(piece, path)).toBe(false));
      pieces.slice(i + 1).forEach((other) => expect(meets(piece, other)).toBe(false));
      expect(meets(piece, building)).toBe(false);
      expect(within(piece, picture)).toBe(true);
    });
  });

  it('runs a path from every street door to the edge of the picture', () => {
    const g = geometryOf(map);
    expect(paths).toHaveLength(g.entries.length);
    paths.forEach((path) => expect(path.x === 0 || path.x + path.w === picture.w || path.y + path.h === picture.h).toBe(true));
  });

  it('stands its lamps inside the picture and off the building', () => {
    lampFeet(map).forEach(([x, y]) => {
      expect(x > 0 && x < picture.w && y > 0 && y < picture.h).toBe(true);
      expect(x >= building.x && x < building.x + building.w && y >= building.y && y < building.y + building.h).toBe(false);
    });
  });
});
