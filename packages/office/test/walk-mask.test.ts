import { describe, expect, it } from 'vitest';
import { slotsFor, type DeskSlot } from '../src/desks.js';
import { buildOffice, type OfficeMap } from '../src/layout.js';
import { propsFor } from '../src/props.js';
import { isFurnished } from '../src/rooms.js';
import { buildSnapshot } from '../src/snapshot.js';
import type { TilePoint, WalkMask } from '../src/types.js';
import { walkGrid, walkMask } from '../src/walk.js';
import { ALL_SERVERS, NOW, luadyStatus } from './fixtures.js';
import { CLASSIC_ROOMS, rooms } from './rooms-fixture.js';

/** Every tile one flood fill over the mask reaches from the given starts. */
const reach = (mask: WalkMask, from: readonly TilePoint[]): Uint8Array => {
  const seen = new Uint8Array(mask.width * mask.height);
  const queue = from.map((t) => t.ty * mask.width + t.tx);
  queue.forEach((k) => { seen[k] = 1; });
  for (let i = 0; i < queue.length; i += 1) {
    const k = queue[i] ?? 0;
    const x = k % mask.width;
    const y = (k - x) / mask.width;
    [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]].forEach(([nx = -1, ny = -1]) => {
      if (nx < 0 || ny < 0 || nx >= mask.width || ny >= mask.height) return;
      const n = ny * mask.width + nx;
      if (seen[n] === 1 || mask.open[n] !== 1) return;
      seen[n] = 1;
      queue.push(n);
    });
  }
  return seen;
};

/** Every furnished room's desks in tight mode (the most crowded floor) and its props with the lounge in. */
const crowded = (map: OfficeMap): { slots: Record<string, readonly DeskSlot[]>; props: ReturnType<typeof propsFor> } => {
  const furnished = map.order.filter((key) => isFurnished(map.rooms[key]!));
  return { slots: Object.fromEntries(furnished.map((key) => [key, slotsFor(map.rooms[key]!, 'tight')])), props: propsFor(map, {}) };
};

describe('walkMask', () => {
  const snap = buildSnapshot({ servers: ALL_SERVERS, rooms: CLASSIC_ROOMS, sessions: [], questions: [], luady: luadyStatus(), now: NOW, previousSeats: {} });
  const mask = walkMask(snap.map, snap.slots, snap.props);

  it('is the walk grid as a mask, sized from the map', () => {
    const grid = walkGrid(snap.map, snap.slots, snap.props);
    expect([mask.width, mask.height]).toEqual([84, 42]);
    expect(mask.open).toHaveLength(84 * 42);
    grid.forEach((row, ty) => row.forEach((open, tx) => expect(mask.open[ty * 84 + tx]).toBe(open ? 1 : 0)));
  });

  it('gives every call its own copy', () => {
    const mine = walkMask(snap.map, snap.slots, snap.props);
    expect(mine.open).not.toBe(mask.open);
    mine.open.fill(0);
    expect(walkMask(snap.map, snap.slots, snap.props).open).toEqual(mask.open);
  });

  it('ignores blocks off the map', () => {
    const odd = [{ id: 'x', kind: 'plant' as const, x: 0, y: 0, sortY: 0, room: null, lounge: false, blocks: [{ x: -3, y: -3, w: 2, h: 2 }, { x: 83, y: 41, w: 9, h: 9 }] }];
    const out = walkMask(snap.map, {}, odd);
    expect(out.open).toHaveLength(84 * 42);
    expect(out.open[41 * 84 + 83]).toBe(0);
  });
});

describe('every desk and every door can be reached from the street doors (one flood fill per office)', () => {
  it.each([0, 1, 2, 3, 4])('with %i rooms, every desk in tight mode', (n) => {
    const map = buildOffice(rooms(n));
    const { slots, props } = crowded(map);
    const mask = walkMask(map, slots, props);
    const seen = reach(mask, map.spots.entries);
    Object.values(slots).flat().forEach((slot) => expect(seen[slot.tile.ty * mask.width + slot.tile.tx]).toBe(1));
    map.order.map((key) => map.rooms[key]!).filter(isFurnished).forEach((room) => {
      const d = room.doorway;
      expect(seen[d.y * mask.width + d.x]).toBe(1);
    });
    expect(seen[map.spots.luadyHome.ty * mask.width + map.spots.luadyHome.tx]).toBe(1);
  });
});
