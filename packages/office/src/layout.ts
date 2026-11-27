import type { GridDTO, RoomDTO } from '@luady/shared';
import { gridFor, slotAt } from '@luady/shared/pure';
import { chunkGridFor, type ChunkGrid } from './chunk-grid.js';
import { geometryFor, geometryOf, slotIndexAt, slotsMeeting, type Geometry } from './grid.js';
import { createMemo } from './memo.js';
import { HQ_ID, LOT_PREFIX, hqRoom, lotRoom, orientationOf, roomFromDto, type RoomDef } from './rooms.js';
import { HQ_SPOT_OFFSETS, offsetTile } from './templates.js';
import { TILE, type PixelPoint, type PixelRect, type TilePoint } from './types.js';

export interface OfficeSpots {
  readonly luadyHome: TilePoint;
  readonly luadySit: PixelPoint;
  /** The street doors: west and east on every band, then the south gate. The tile a walker steps in on. */
  readonly entries: readonly TilePoint[];
  readonly taskWall: TilePoint;
  readonly bench: TilePoint;
  readonly benchVisit: TilePoint;
}

export interface OfficeZones {
  /** The building itself, without the dark ring round it. */
  readonly all: PixelRect;
  readonly hq: PixelRect;
  readonly workshop: PixelRect;
  /** The full building width across HQ's band: the camera's opening view when the whole office does not fit. */
  readonly hqRow: PixelRect;
  /** The corridor down from HQ to the lower streets; null while the office has one band (R = 1). */
  readonly avenue: PixelRect | null;
  /** Rooms, HQ, streets and the avenue: what the daytime tint covers (it skips the courts below HQ). */
  readonly indoor: readonly PixelRect[];
}

export interface OfficeMap {
  /** Keys: room ids, HQ, and `lot-<position>` for empty slots. */
  readonly rooms: Readonly<Record<string, RoomDef>>;
  /** Slot 0, slot 1, HQ, then slots 2 and up: every slot of the grid, a room or a lot. */
  readonly order: readonly string[];
  /** The grid exactly as the hub computes it: slotCount = max(position) + 1, then gridFor. */
  readonly grid: GridDTO;
  readonly spots: OfficeSpots;
  readonly zones: OfficeZones;
  readonly width: number;
  readonly height: number;
  /** Changes exactly when the geometry changes: K, R, then each room's id, kind, position and orientation. */
  readonly layoutKey: string;
  readonly chunks: ChunkGrid;
  /** Input the map could not use (unknown kinds, repeats, reserved ids, positions out of range) or draws differently, one plain line each. */
  readonly problems: readonly string[];
}

const box = (x: number, y: number, w: number, h: number): PixelRect => Object.freeze({ x, y, w, h });
const px = (r: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }): PixelRect => box(r.x * TILE, r.y * TILE, r.w * TILE, r.h * TILE);

/** HQ's spots in a grid: the manager's place and seat, the task wall in front of HQ's board, the workbench. */
const spotsOf = (g: Geometry): OfficeSpots => {
  const at = (t: TilePoint): TilePoint => offsetTile(t, g.hqMid, 0);
  const entries = g.entryTiles;
  return Object.freeze({
    luadyHome: at(HQ_SPOT_OFFSETS.home),
    luadySit: Object.freeze({ x: g.hqMid * TILE + HQ_SPOT_OFFSETS.sit.x, y: HQ_SPOT_OFFSETS.sit.y }),
    entries,
    taskWall: at(HQ_SPOT_OFFSETS.taskWall),
    bench: at(HQ_SPOT_OFFSETS.bench),
    benchVisit: at(HQ_SPOT_OFFSETS.benchVisit),
  });
};

/** HQ's south part, where the workbench stands: its last 14 rows. */
const WORKSHOP_ROWS = 14;

/** Camera targets that are not a whole room, and the indoor parts the daytime tint covers. */
const zonesOf = (g: Geometry, rooms: readonly RoomDef[]): OfficeZones => {
  const all = px(g.building);
  const hq = px(g.hqRect);
  return Object.freeze({
    all,
    hq,
    workshop: box(hq.x, hq.y + hq.h - WORKSHOP_ROWS * TILE, hq.w, WORKSHOP_ROWS * TILE),
    hqRow: box(all.x, hq.y, all.w, hq.h),
    avenue: g.avenue === null ? null : px(g.avenue),
    indoor: Object.freeze([...rooms.map((r) => px(r.rect)), ...g.streets.map((s) => px(s.rect))]),
  });
};


/**
 * Positions from this one on are refused (with a line in `problems`). A sanity bound against bad input, not a limit on
 * rooms: the hub hands out positions below its grid's capacity, about twice the number of rooms there have been, and
 * its 3 MiB body limit stops a room list near 90,000 ids. At this bound the office still lays out (100,000 slots,
 * a 52 MB walk mask) instead of trying to allocate whatever a stray number asks for.
 */
export const POSITION_LIMIT = 100_000;

const ROOM_KINDS: ReadonlySet<string> = new Set(['server', 'project', 'local']);
const RESERVED = (id: string): boolean => id === HQ_ID || id.startsWith(LOT_PREFIX) || id.startsWith('vacant-');

interface Accepted { readonly rooms: readonly RoomDTO[]; readonly problems: readonly string[] }

const whyNot = (room: RoomDTO, ids: ReadonlySet<string>, positions: ReadonlySet<number>): string | null => {
  if (!ROOM_KINDS.has(room.kind)) return `has an unknown kind (${String(room.kind)})`;
  if (!Number.isInteger(room.position) || room.position < 0) return `has no valid position (${String(room.position)})`;
  if (room.position >= POSITION_LIMIT) return `has position ${room.position}, beyond the last the office lays out (${POSITION_LIMIT - 1})`;
  if (RESERVED(room.id)) return 'uses a reserved id';
  if (ids.has(room.id)) return 'repeats an id';
  return positions.has(room.position) ? `repeats position ${room.position}` : null;
};

/** Keeps the rooms the map can place: known kinds, whole positions in range, no reserved ids, the first of each id and position. */
const accept = (input: readonly RoomDTO[]): Accepted => {
  const ids = new Set<string>();
  const positions = new Set<number>();
  const rooms: RoomDTO[] = [];
  const problems: string[] = [];
  input.forEach((room) => {
    const why = whyNot(room, ids, positions);
    if (why !== null) {
      problems.push(`room ${room.id} ${why}: ignored`);
      return;
    }
    ids.add(room.id);
    positions.add(room.position);
    rooms.push(room);
  });
  return { rooms: rooms.toSorted((a, b) => a.position - b.position), problems };
};

/** The hub's grid for these rooms; the rooms come sorted by position. */
const gridOf = (rooms: readonly RoomDTO[]): GridDTO => {
  const last = rooms.at(-1);
  const slotCount = last === undefined ? 0 : last.position + 1;
  return Object.freeze({ slotCount, ...gridFor(slotCount) });
};

/** K, R, then each room's id, kind, position and orientation. */
const layoutKeyOf = (grid: GridDTO, rooms: readonly RoomDTO[]): string =>
  `K${grid.K}R${grid.R}|${rooms.map((r) => `${r.id}:${r.kind}:${r.position}:${orientationOf(slotAt(r.position))}`).join(',')}`;

/** Everything else a drawn room takes from its row: a change gives a new map with the same layout key. */
const looksKey = (rooms: readonly RoomDTO[]): string =>
  rooms.map((r) => [r.host ?? '', r.name, r.short, r.colour, r.accent, r.species].join('\u0001')).join('\u0002');

const layOut = (accepted: Accepted): OfficeMap => {
  const grid = gridOf(accepted.rooms);
  const g = geometryFor(grid.K, grid.R);
  const byPosition = new Map(accepted.rooms.map((r) => [r.position, r]));
  const slots = Array.from({ length: grid.capacity }, (_, i) => {
    const dto = byPosition.get(i);
    return dto === undefined ? lotRoom(slotAt(i), g) : roomFromDto(dto, slotAt(i), g);
  });
  const [s0, s1, ...rest] = slots;
  const ordered = [s0, s1, hqRoom(g), ...rest].filter((r): r is RoomDef => r !== undefined);
  const width = g.cols * TILE;
  const height = g.rows * TILE;
  return Object.freeze({
    rooms: Object.freeze(Object.fromEntries(ordered.map((r) => [r.id, r]))),
    order: Object.freeze(ordered.map((r) => r.id)),
    grid,
    spots: spotsOf(g),
    zones: zonesOf(g, ordered),
    width,
    height,
    layoutKey: layoutKeyOf(grid, accepted.rooms),
    chunks: chunkGridFor(width, height),
    problems: Object.freeze([...accepted.problems]),
  });
};

/** The last few maps: a long session of room edits cannot grow it. */
export const OFFICE_MEMO_LIMIT = 8;
const MAPS = createMemo<OfficeMap>(OFFICE_MEMO_LIMIT);

/**
 * Lays out the building for these rooms, any number of them: each at its slot of the block grid round HQ, every other
 * slot of the grid a lot. Unknown kinds, repeated ids or positions, reserved ids and
 * positions from POSITION_LIMIT on are ignored and listed in `problems`. The same rooms always give back the same
 * (frozen) map.
 */
export function buildOffice(rooms: readonly RoomDTO[]): OfficeMap {
  const accepted = accept(rooms);
  const key = [layoutKeyOf(gridOf(accepted.rooms), accepted.rooms), looksKey(accepted.rooms), ...accepted.problems].join('\n');
  return MAPS.get(key, () => layOut(accepted));
}

/** A room's rectangle in pixels. */
export function roomRectPx(room: RoomDef): PixelRect {
  return px(room.rect);
}

const SLOT_KEYS = new WeakMap<OfficeMap, readonly (string | undefined)[]>();

/** Room keys by slot index: `order` without HQ. */
const slotKeys = (map: OfficeMap): readonly (string | undefined)[] => {
  const known = SLOT_KEYS.get(map);
  if (known !== undefined) return known;
  const keys: (string | undefined)[] = [];
  map.order.forEach((key) => {
    const slot = map.rooms[key]?.slot;
    if (slot !== null && slot !== undefined) keys[slot.index] = key;
  });
  SLOT_KEYS.set(map, keys);
  return keys;
};

/** The room in a slot of the map: a room or a lot; undefined off the grid. */
export function roomInSlot(map: OfficeMap, index: number): RoomDef | undefined {
  const key = slotKeys(map)[index];
  return key === undefined ? undefined : map.rooms[key];
}

/** The key of the room under a pixel, or null for streets, courts and the outside. O(1): the slot comes from the pixel. */
export function roomAtPx(map: OfficeMap, x: number, y: number): string | null {
  const index = slotIndexAt(geometryOf(map), Math.floor(x / TILE), Math.floor(y / TILE));
  if (index === -2) return HQ_ID;
  return index < 0 ? null : (slotKeys(map)[index] ?? null);
}

const meetsPx = (a: PixelRect, b: PixelRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The rooms whose rectangles meet a pixel frame, lots and HQ included, in map order (slot 0, slot 1, HQ, then the
 * rest). O(rooms met): the slots come from the frame by arithmetic, never from a scan over every room.
 */
export function roomsMeeting(map: OfficeMap, win: PixelRect): readonly RoomDef[] {
  if (win.w <= 0 || win.h <= 0) return [];
  const tx = Math.floor(win.x / TILE);
  const ty = Math.floor(win.y / TILE);
  const slots = slotsMeeting(geometryOf(map), { x: tx, y: ty, w: Math.ceil((win.x + win.w) / TILE) - tx, h: Math.ceil((win.y + win.h) / TILE) - ty });
  const hq = map.rooms[HQ_ID];
  const withHq = hq !== undefined && meetsPx(roomRectPx(hq), win);
  const rooms = slots.flatMap((i) => roomInSlot(map, i) ?? []);
  const split = slots.filter((i) => i < 2).length;
  return withHq ? [...rooms.slice(0, split), hq, ...rooms.slice(split)] : rooms;
}
