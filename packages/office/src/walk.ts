import type { DeskSlot } from './desks.js';
import { geometryOf, slotIndexAt } from './grid.js';
import type { OfficeMap } from './layout.js';
import { createMemo } from './memo.js';
import type { PropDef } from './props.js';
import { HQ_ID, isFurnished, type RoomDef } from './rooms.js';
import { TILE, type TileRect, type WalkMask } from './types.js';
import { guide, type WalkGuide } from './walk-guide.js';

/** walk[ty][tx]: true where a creature may step. */
export type WalkGrid = readonly (readonly boolean[])[];

const rect = (x: number, y: number, w: number, h: number): TileRect => ({ x, y, w, h });

/** The floor inside the walls: one tile in from the sides, two below the top wall, one above the bottom wall. */
const interior = (room: RoomDef): TileRect => rect(room.rect.x + 1, room.rect.y + 2, room.rect.w - 2, room.rect.h - 3);

/** Room floors and doors: furnished rooms and HQ. Empty slots stay closed. */
const openAreas = (map: OfficeMap): readonly TileRect[] =>
  map.order.flatMap((key) => {
    const room = map.rooms[key];
    if (room === undefined) return [];
    if (isFurnished(room)) return [interior(room), room.doorway];
    return room.kind === HQ_ID ? [interior(room)] : [];
  });

/**
 * The halls of the grid: every street without its outer wall, the avenue without its last row, the street doors and
 * HQ's doors, for any K and R. The courts are never open.
 */
const halls = (map: OfficeMap): readonly TileRect[] => {
  const g = geometryOf(map);
  return [...g.streets.map((s) => s.hall), ...g.entries, ...g.hqDoors];
};

const sizeOf = (map: OfficeMap): { readonly width: number; readonly height: number } =>
  ({ width: Math.ceil(map.width / TILE), height: Math.ceil(map.height / TILE) });

/** Writes `value` into every tile of `r` that lies on the mask. */
const fill = (mask: Uint8Array, width: number, height: number, r: TileRect, value: 0 | 1): void => {
  const x0 = Math.max(0, r.x);
  const x1 = Math.min(width, r.x + r.w);
  for (let ty = Math.max(0, r.y); ty < Math.min(height, r.y + r.h); ty += 1) mask.fill(value, ty * width + x0, ty * width + Math.max(x0, x1));
};

/** Static open masks (floors, halls, entries, doors) of the last few layouts; never handed out, only copied. */
const STATIC = createMemo<Uint8Array>(8);
let builds = 0;

const staticMask = (map: OfficeMap): Uint8Array => STATIC.get(map.layoutKey, () => {
  builds += 1;
  const { width, height } = sizeOf(map);
  const mask = new Uint8Array(width * height);
  [...openAreas(map), ...halls(map)].forEach((r) => fill(mask, width, height, r, 1));
  return mask;
});

const GUIDES = new WeakMap<OfficeMap, WalkGuide>();

/** The map's rooms as pockets for findPath: a furnished room's floor and door are its slot's pocket. */
const guideFor = (map: OfficeMap): WalkGuide => {
  const known = GUIDES.get(map);
  if (known !== undefined) return known;
  const g = geometryOf(map);
  const furnished = new Uint8Array(map.grid.capacity);
  map.order.forEach((key) => {
    const room = map.rooms[key];
    if (room !== undefined && room.slot !== null && isFurnished(room)) furnished[room.slot.index] = 1;
  });
  const made: WalkGuide = Object.freeze({
    pocketOf: (tx: number, ty: number): number => {
      const slot = slotIndexAt(g, tx, ty);
      return slot >= 0 && furnished[slot] === 1 ? slot : -1;
    },
  });
  GUIDES.set(map, made);
  return made;
};

/** How many static masks have been built so far (the operation count the tests assert: one per layout key). */
export function walkMaskBuilds(): number {
  return builds;
}

/**
 * Which tiles can be walked, as a mask: room floors, streets, the avenue and doors, minus furniture and
 * desks. Empty slots and courts stay closed. The static part is computed once per layout key; every call returns its
 * own copy.
 */
export function walkMask(map: OfficeMap, slots: Readonly<Record<string, readonly DeskSlot[]>>, props: readonly PropDef[]): WalkMask {
  const { width, height } = sizeOf(map);
  const open = staticMask(map).slice();
  Object.values(slots).forEach((list) => list.forEach((s) => s.blocks.forEach((b) => {
    if (b.tx >= 0 && b.ty >= 0 && b.tx < width && b.ty < height) open[b.ty * width + b.tx] = 0;
  })));
  props.forEach((p) => p.blocks.forEach((r) => fill(open, width, height, r, 0)));
  const mask: WalkMask = Object.freeze({ width, height, open });
  guide(mask, guideFor(map));
  return mask;
}

/** walkMask as rows of booleans: walk[ty][tx]. */
export function walkGrid(map: OfficeMap, slots: Readonly<Record<string, readonly DeskSlot[]>>, props: readonly PropDef[]): WalkGrid {
  const { width, height, open } = walkMask(map, slots, props);
  const grid: WalkGrid = Object.freeze(Array.from({ length: height }, (_, ty) => Object.freeze(Array.from({ length: width }, (_, tx) => open[ty * width + tx] === 1))));
  guide(grid, guideFor(map));
  return grid;
}
