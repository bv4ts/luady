import type { BoardKind } from './decor.js';
import type { PropKind } from './props.js';
import type { Orientation } from './rooms.js';
import { TILE as T, type TilePoint, type TileRect } from './types.js';

/**
 * Where things stand, as offsets from a base tile: a room's pieces from its rectangle's top-left, a street segment's
 * from the segment's top-left, HQ's from (hqMid, 0). The values are the classic office's hand-placed coordinates of
 * the four corners, corridors and HQ with their base taken off, so the first ring of any office is the classic office
 * exactly.
 */

/** One piece of furniture: its sprite's top-left and floor line in pixels, and the tiles it blocks, from the base. */
export interface Piece {
  readonly kind: PropKind;
  readonly px: number;
  readonly py: number;
  readonly ps: number;
  /** Blocked tiles, x0, y0, x1, y1 inclusive. */
  readonly block: readonly [number, number, number, number];
  /** Lounge furniture: out only while its room's lounge is (see loungeOn). */
  readonly lounge: boolean;
}

export interface RoomTemplate {
  /** Where you stand inside. */
  readonly inside: TilePoint;
  /** The door through the street wall, near the HQ side. */
  readonly door: TileRect;
  /** The rack's top-left tile, against the back wall. */
  readonly rack: TilePoint;
  /** The wall board: `dx` tiles in, `w` pixels wide; its top is 9 px below the room's top edge. */
  readonly board: { readonly dx: number; readonly w: number; readonly kind: BoardKind };
  readonly rug: TileRect | null;
  /** Which side of the wall board the links board hangs on. */
  readonly links: 'west' | 'east';
  /** The plant by the front wall. */
  readonly plant: Piece;
  readonly lounge: readonly Piece[];
}

const piece = (kind: PropKind, px: number, py: number, ps: number, block: readonly [number, number, number, number], lounge = false): Piece =>
  Object.freeze({ kind, px, py, ps, block: Object.freeze(block), lounge });
const at = (tx: number, ty: number): TilePoint => Object.freeze({ tx, ty });
const box = (x: number, y: number, w: number, h: number): TileRect => Object.freeze({ x, y, w, h });

const WEST_PLANT = piece('plant', 1 * T + 1, 16 * T - 21, 16 * T - 1, [1, 15, 1, 15]);
const EAST_PLANT = piece('plant', 24 * T + 1, 16 * T - 21, 16 * T - 1, [24, 15, 24, 15]);
const TABLE_LOUNGE = Object.freeze([piece('table', 13 * T, 12 * T - 2, 14 * T, [13, 12, 16, 13], true)]);
const PLANT_LOUNGE = Object.freeze([
  piece('plant', 4 * T + 1, 13 * T - 21, 13 * T - 1, [4, 12, 4, 12], true),
  piece('plant', 9 * T + 1, 14 * T - 21, 14 * T - 1, [9, 13, 9, 13], true),
  piece('plant', 14 * T + 1, 13 * T - 21, 13 * T - 1, [14, 12, 14, 12], true),
]);

/** The four orientations; west rooms keep their door and rack at the HQ end, east rooms too (mirrored). */
export const ROOM_TEMPLATES: Readonly<Record<Orientation, RoomTemplate>> = Object.freeze({
  'west-north': Object.freeze({
    inside: at(20, 13), door: box(20, 16, 2, 1), rack: at(23, 2), board: Object.freeze({ dx: 18, w: 62, kind: 'kanban' as const }),
    rug: null, links: 'west' as const, plant: WEST_PLANT, lounge: Object.freeze([]),
  }),
  'east-north': Object.freeze({
    inside: at(5, 13), door: box(4, 16, 2, 1), rack: at(1, 2), board: Object.freeze({ dx: 3, w: 56, kind: 'team' as const }),
    rug: box(8, 11, 15, 4), links: 'east' as const, plant: EAST_PLANT, lounge: TABLE_LOUNGE,
  }),
  'west-south': Object.freeze({
    inside: at(20, 3), door: box(20, 0, 2, 2), rack: at(23, 2), board: Object.freeze({ dx: 13, w: 56, kind: 'team' as const }),
    rug: box(2, 11, 15, 4), links: 'west' as const, plant: WEST_PLANT, lounge: PLANT_LOUNGE,
  }),
  'east-south': Object.freeze({
    inside: at(5, 3), door: box(4, 0, 2, 2), rack: at(1, 2), board: Object.freeze({ dx: 7, w: 56, kind: 'team' as const }),
    rug: box(8, 11, 15, 4), links: 'east' as const, plant: EAST_PLANT, lounge: TABLE_LOUNGE,
  }),
});

/** Orientations in the order their lounge pieces are listed (in the classic office: Harbor's table, Private Projects' table, Meadow's plants). */
export const LOUNGE_ORDER: readonly Orientation[] = Object.freeze(['east-north', 'east-south', 'west-south'] as const);

/** The furniture of one street segment (a block's 26 × 6 stretch of street), by the block's side. */
export const STREET_PIECES: Readonly<Record<'west' | 'east', readonly Piece[]>> = Object.freeze({
  west: Object.freeze([
    piece('sofa', 7 * T + 2, T - 20, T, [7, 0, 10, 0]),
    piece('coffee', 12 * T + 1, T - 22, T, [12, 0, 12, 0]),
    piece('plant', 3 * T + 1, T - 21, T - 1, [3, 0, 3, 0]),
  ]),
  east: Object.freeze([
    piece('plant', 21 * T + 1, T - 21, T - 1, [21, 0, 21, 0]),
    piece('table', 13 * T, 2 * T - 2, 4 * T, [13, 2, 16, 3]),
  ]),
});

/** HQ's work furniture (the manager's desk, the workbench, the versions shelf), from (hqMid, 0). */
export const HQ_WORK_PIECES: readonly Piece[] = Object.freeze([
  piece('luadydesk', -2 * T, 19 * T - 2, 21 * T, [-2, 19, 1, 20]),
  piece('workbench', -5 * T, 37 * T - 22, 37 * T, [-5, 36, -1, 36]),
  piece('versions', 1 * T, 32 * T - 26, 32 * T, [1, 31, 5, 31]),
]);

/** HQ furnished as a manager's office (its fixtures are in fixtures.ts), from (hqMid, 0). */
export const HQ_ROOM_PIECES: readonly Piece[] = Object.freeze([
  piece('plant', -14 * T + 1, 4 * T - 21, 4 * T - 1, [-14, 3, -14, 3]),
  piece('plant', 13 * T + 1, 6 * T - 21, 6 * T - 1, [13, 5, 13, 5]),
  piece('readbench', -1 * T + 4, 6 * T - 16, 6 * T, [-1, 5, 4, 5]),
  piece('meeting', 6 * T, 12 * T - 64, 12 * T, [6, 8, 11, 11]),
  piece('cooler', 13 * T + 1, 14 * T - 28, 14 * T, [13, 13, 13, 13]),
  piece('coffee', -14 * T + 1, 15 * T - 22, 15 * T, [-14, 14, -14, 14]),
  piece('plant', -14 * T + 1, 17 * T - 21, 17 * T - 1, [-14, 16, -14, 16]),
  piece('sofa', 8 * T + 2, 28 * T - 20, 28 * T, [8, 27, 11, 27]),
  piece('plant', 12 * T + 1, 28 * T - 21, 28 * T - 1, [12, 27, 12, 27]),
  piece('plant', -14 * T + 1, 39 * T - 21, 39 * T - 1, [-14, 38, -14, 38]),
  piece('plant', 13 * T + 1, 39 * T - 21, 39 * T - 1, [13, 38, 13, 38]),
]);

/** HQ's rugs, from (hqMid, 0): round the manager's desk, then the reading corner and the sofa corner with their colours. */
export const HQ_DESK_RUG: TileRect = box(-5, 16, 10, 8);
export const HQ_CORNER_RUGS: readonly (readonly [TileRect, string])[] = Object.freeze([
  [box(-14, 7, 7, 5), '#c98a4a'],
  [box(6, 25, 8, 5), '#7c5cff'],
] as const);

/** HQ's spots, from (hqMid, 0): the manager's place and seat, the task wall, the workbench and its visitor's tile. */
export const HQ_SPOT_OFFSETS = Object.freeze({
  home: at(-1, 18),
  sit: Object.freeze({ x: 0, y: 19 * T + 2 }),
  inside: at(0, 22),
  taskWall: at(-9, 3),
  bench: at(-3, 35),
  benchVisit: at(1, 37),
});

/** A piece placed from its base tile: its pixels and its blocked tiles. */
export function placePiece(p: Piece, baseX: number, baseY: number): { readonly x: number; readonly y: number; readonly sortY: number; readonly block: TileRect } {
  const [x0, y0, x1, y1] = p.block;
  return {
    x: baseX * T + p.px,
    y: baseY * T + p.py,
    sortY: baseY * T + p.ps,
    block: box(baseX + x0, baseY + y0, x1 - x0 + 1, y1 - y0 + 1),
  };
}

/** A template tile or rectangle moved onto a base. */
export const offsetTile = (t: TilePoint, baseX: number, baseY: number): TilePoint => at(baseX + t.tx, baseY + t.ty);
export const offsetRect = (r: TileRect, baseX: number, baseY: number): TileRect => box(baseX + r.x, baseY + r.y, r.w, r.h);
