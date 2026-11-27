import { isFurnished, type RoomDef } from './rooms.js';
import { TILE, type PixelPoint, type TilePoint } from './types.js';

/** One desk: where the sitter stands (tile), where the desk is drawn, where the sitter is drawn, and the tiles it covers. */
export interface DeskSlot {
  readonly index: number;
  readonly tile: TilePoint;
  readonly desk: PixelPoint;
  readonly sit: PixelPoint;
  readonly blocks: readonly TilePoint[];
}

/** 'normal' is the roomy arrangement; 'tight' packs more desks and drops the lounge furniture. */
export type DeskMode = 'normal' | 'tight';

export const DESK_CAPACITY: Readonly<Record<DeskMode, number>> = Object.freeze({ normal: 12, tight: 20 });

interface Arrangement { readonly rows: readonly number[]; readonly west: readonly number[]; readonly east: readonly number[] }

/** Offsets from the room's top-left tile. Columns are listed door side first. */
const ARRANGEMENTS: Readonly<Record<DeskMode, Arrangement>> = Object.freeze({
  normal: Object.freeze({ rows: [4, 8, 12], west: [14, 10, 6, 2], east: [8, 12, 16, 20] }),
  tight: Object.freeze({ rows: [4, 7, 10, 13], west: [17, 13, 9, 5, 1], east: [6, 10, 14, 18, 22] }),
});

/** 12 or fewer sessions fit the normal arrangement; more need the tight one. */
export function deskModeFor(count: number): DeskMode {
  return count > DESK_CAPACITY.normal ? 'tight' : 'normal';
}

const makeSlot = (index: number, col: number, row: number): DeskSlot =>
  Object.freeze({
    index,
    tile: Object.freeze({ tx: col, ty: row - 1 }),
    desk: Object.freeze({ x: col * TILE, y: row * TILE - 2 }),
    sit: Object.freeze({ x: col * TILE + 16, y: row * TILE + 2 }),
    blocks: Object.freeze([0, 1, 2].map((dx) => Object.freeze({ tx: col + dx, ty: row }))),
  });

const NO_DESKS: readonly DeskSlot[] = Object.freeze([]);
/** Desk lists per room and mode: kept as long as the room (and so its map) is, whatever the number of rooms. */
const SLOTS = new WeakMap<RoomDef, Partial<Record<DeskMode, readonly DeskSlot[]>>>();

/**
 * The desks of a furnished room in index order: row by row, door side first. HQ and empty slots have none.
 * The same room and mode always give back the same (frozen) list.
 */
export function slotsFor(room: RoomDef, mode: DeskMode): readonly DeskSlot[] {
  if (!isFurnished(room) || room.side === 'centre') return NO_DESKS;
  const mine = SLOTS.get(room) ?? {};
  const known = mine[mode];
  if (known !== undefined) return known;
  const plan = ARRANGEMENTS[mode];
  const cols = room.side === 'west' ? plan.west : plan.east;
  const cells = plan.rows.flatMap((dy) => cols.map((dx) => ({ col: room.rect.x + dx, row: room.rect.y + dy })));
  const made = Object.freeze(cells.map((c, i) => makeSlot(i, c.col, c.row)));
  SLOTS.set(room, { ...mine, [mode]: made });
  return made;
}
