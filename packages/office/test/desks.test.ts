import { describe, expect, it } from 'vitest';
import { DESK_CAPACITY, deskModeFor, slotsFor, type DeskMode } from '../src/desks.js';
import { buildOffice } from '../src/layout.js';
import type { RoomDef } from '../src/rooms.js';
import { classicRooms } from './rooms-fixture.js';

const map = buildOffice(classicRooms(['cedar', 'birch', 'ash', 'local']));
const CORNER_ROOMS = ['birch', 'ash', 'cedar', 'local'] as const;
const room = (id: string): RoomDef => {
  const r = map.rooms[id];
  if (r === undefined) throw new Error(`no room ${id}`);
  return r;
};
const key = (tx: number, ty: number): string => `${tx},${ty}`;

describe('desk modes', () => {
  it('holds 12 desks normally and 20 when tight', () => {
    expect(DESK_CAPACITY).toEqual({ normal: 12, tight: 20 });
    expect(Object.isFrozen(DESK_CAPACITY)).toBe(true);
  });

  it('switches to tight above 12 sessions', () => {
    expect(deskModeFor(0)).toBe('normal');
    expect(deskModeFor(12)).toBe('normal');
    expect(deskModeFor(13)).toBe('tight');
    expect(deskModeFor(40)).toBe('tight');
  });
});

describe('slotsFor normal', () => {
  it('places the desks of the west room door side first', () => {
    const slots = slotsFor(room('birch'), 'normal');
    expect(slots).toHaveLength(12);
    expect(slots[0]).toMatchObject({ index: 0, tile: { tx: 15, ty: 4 }, desk: { x: 240, y: 78 }, sit: { x: 256, y: 82 } });
    expect(slots[0]?.blocks).toEqual([{ tx: 15, ty: 5 }, { tx: 16, ty: 5 }, { tx: 17, ty: 5 }]);
    expect(slots.slice(0, 4).map((s) => s.tile.tx)).toEqual([15, 11, 7, 3]);
    expect(slots.map((s) => s.tile.ty)).toEqual([4, 4, 4, 4, 8, 8, 8, 8, 12, 12, 12, 12]);
    expect(slots.map((s) => s.index)).toEqual([...Array(12).keys()]);
  });

  it('places the desks of the east room', () => {
    const slots = slotsFor(room('ash'), 'normal');
    expect(slots[0]?.tile).toEqual({ tx: 65, ty: 4 });
    expect(slots.slice(0, 4).map((s) => s.tile.tx)).toEqual([65, 69, 73, 77]);
  });

  it('works from the room rectangle for the south rooms', () => {
    expect(slotsFor(room('cedar'), 'normal')[0]?.tile).toEqual({ tx: 15, ty: 27 });
    expect(slotsFor(room('local'), 'normal')[11]?.tile).toEqual({ tx: 77, ty: 35 });
  });
});

describe('slotsFor tight', () => {
  it('has 20 desks', () => {
    const slots = slotsFor(room('birch'), 'tight');
    expect(slots).toHaveLength(20);
    expect(slots.slice(0, 5).map((s) => s.tile.tx)).toEqual([18, 14, 10, 6, 2]);
    expect(slotsFor(room('ash'), 'tight').slice(0, 5).map((s) => s.tile.tx)).toEqual([63, 67, 71, 75, 79]);
    expect(slots.filter((_, i) => i % 5 === 0).map((s) => s.tile.ty)).toEqual([4, 7, 10, 13]);
  });

  it.each(CORNER_ROOMS)('never puts two desks of %s on one tile', (id) => {
    const tiles = slotsFor(room(id), 'tight').flatMap((s) => s.blocks.map((b) => key(b.tx, b.ty)));
    expect(new Set(tiles).size).toBe(tiles.length);
  });

  it.each(CORNER_ROOMS)('keeps every desk of %s inside the room, off the door column and the inside tile', (id) => {
    const r = room(id);
    const doorCols = new Set(Array.from({ length: r.doorway.w }, (_, i) => r.doorway.x + i));
    slotsFor(r, 'tight').forEach((slot) => {
      slot.blocks.forEach((b) => {
        expect(b.tx).toBeGreaterThanOrEqual(r.rect.x + 1);
        expect(b.tx).toBeLessThanOrEqual(r.rect.x + r.rect.w - 2);
        expect(b.ty).toBeGreaterThanOrEqual(r.rect.y + 2);
        expect(b.ty).toBeLessThanOrEqual(r.rect.y + r.rect.h - 2);
        expect(doorCols.has(b.tx)).toBe(false);
        expect(key(b.tx, b.ty)).not.toBe(key(r.inside.tx, r.inside.ty));
      });
    });
  });

  it.each(CORNER_ROOMS)('leaves the standing tile of every %s desk free of desks', (id) => {
    (['normal', 'tight'] as DeskMode[]).forEach((mode) => {
      const slots = slotsFor(room(id), mode);
      const blocked = new Set(slots.flatMap((s) => s.blocks.map((b) => key(b.tx, b.ty))));
      slots.forEach((s) => expect(blocked.has(key(s.tile.tx, s.tile.ty))).toBe(false));
    });
  });
});

describe('rooms without desks', () => {
  it('gives HQ and lots no desks', () => {
    expect(slotsFor(room('hq'), 'normal')).toEqual([]);
    expect(slotsFor(room('hq'), 'tight')).toEqual([]);
    const lot = buildOffice(classicRooms(['birch'])).rooms['lot-1'];
    expect(lot && slotsFor(lot, 'tight')).toEqual([]);
  });

  it('returns frozen slots', () => {
    const slots = slotsFor(room('cedar'), 'normal');
    expect(Object.isFrozen(slots)).toBe(true);
    expect(Object.isFrozen(slots[0])).toBe(true);
    expect(Object.isFrozen(slots[0]?.blocks)).toBe(true);
  });
});
