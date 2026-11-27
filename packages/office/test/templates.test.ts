import { describe, expect, it } from 'vitest';
import { slotsFor, type DeskMode } from '../src/desks.js';
import { fixturesFor } from '../src/fixtures.js';
import { geometryOf } from '../src/grid.js';
import { buildOffice, roomRectPx } from '../src/layout.js';
import { propsFor } from '../src/props.js';
import { HQ_ID, isFurnished } from '../src/rooms.js';
import type { PixelRect, TileRect } from '../src/types.js';
import { rooms } from './rooms-fixture.js';

const SIZES = [1, 4, 5, 24, 100, 300] as const;
const tilesOf = (r: TileRect): readonly string[] =>
  Array.from({ length: r.w * r.h }, (_, k) => `${r.x + (k % r.w)},${r.y + Math.floor(k / r.w)}`);
const insidePx = (outer: PixelRect, inner: PixelRect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

describe('HQ\'s south door and the workbench', () => {
  it.each([24, 300])('stays clear at %i rooms: the door, and the three rows inside it, hold no furniture', (n) => {
    const map = buildOffice(rooms(n));
    const g = geometryOf(map);
    const south = g.hqDoors[2]!;
    expect(south).toEqual({ x: g.hqMid - 1, y: 40, w: 2, h: 1 });
    const blocked = new Set(propsFor(map, {}).flatMap((p) => p.blocks.flatMap(tilesOf)));
    const workbench = propsFor(map, {}).find((p) => p.kind === 'workbench')!;
    expect(workbench.blocks).toEqual([{ x: g.hqMid - 5, y: 36, w: 5, h: 1 }]);
    [south, { x: south.x, y: 37, w: 2, h: 3 }].flatMap(tilesOf).forEach((t) => expect(blocked.has(t)).toBe(false));
  });
});

describe.each(SIZES)('the furniture of %i rooms', (n) => {
  const map = buildOffice(rooms(n));
  const g = geometryOf(map);

  it.each(['normal', 'tight'] as DeskMode[])('never stands on a desk, a door or a street door (%s desks)', (mode) => {
    const furnished = map.order.filter((key) => isFurnished(map.rooms[key]!));
    const lounge = Object.fromEntries(furnished.map((key) => [key, mode === 'normal']));
    const props = propsFor(map, lounge, { jiraRooms: furnished });
    const blocked = new Set(props.flatMap((p) => p.blocks.flatMap(tilesOf)));
    furnished.forEach((key) => {
      const room = map.rooms[key]!;
      const desks = slotsFor(room, mode).slice(0, mode === 'normal' ? 8 : undefined);
      desks.forEach((s) => [s.tile, ...s.blocks].forEach((t) => expect(blocked.has(`${t.tx},${t.ty}`)).toBe(false)));
      tilesOf(room.doorway).forEach((t) => expect(blocked.has(t)).toBe(false));
    });
    [...g.entries, ...g.hqDoors].flatMap(tilesOf).forEach((t) => expect(blocked.has(t)).toBe(false));
  });

  it('keeps every room\'s furniture and fixtures inside that room, and the rest in HQ or on a street', () => {
    const props = propsFor(map, Object.fromEntries(map.order.map((k) => [k, true])), { jiraRooms: map.order });
    const streets = g.streets.map((s) => s.rect);
    props.forEach((p) => {
      p.blocks.forEach((b) => {
        if (p.room === null) expect(streets.some((s) => b.x >= s.x && b.y >= s.y && b.x + b.w <= s.x + s.w && b.y + b.h <= s.y + s.h)).toBe(true);
        else {
          const r = map.rooms[p.room]!.rect;
          expect(b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h).toBe(true);
        }
      });
    });
    fixturesFor(map, { jiraRooms: map.order }).forEach((f) => expect([f.id, insidePx(roomRectPx(map.rooms[f.room]!), f.box)]).toEqual([f.id, true]));
    expect(new Set(props.map((p) => p.id)).size).toBe(props.length);
    expect(props.filter((p) => p.room === HQ_ID && p.kind === 'luadydesk')).toHaveLength(1);
  });
});
