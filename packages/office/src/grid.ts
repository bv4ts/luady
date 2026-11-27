import type { Slot, SlotHalf, SlotSide } from '@luady/shared';
import { createMemo } from './memo.js';
import type { TilePoint, TileRect } from './types.js';

/**
 * The block grid round HQ, in tiles. A block is a north room, a street segment and a south
 * room: 26 tiles wide and one band (40) tall. K blocks stand on each side of HQ's column and R bands run down; HQ fills
 * the centre of the first band, and below it the avenue runs down between courts. Everything here is arithmetic on K
 * and R: nothing assumes a number of rooms, and K = R = 1 is the classic four-room office exactly.
 */

/** A room's width and height. */
export const ROOM_W = 26;
export const ROOM_H = 17;
/** A street between a band's north and south rooms. */
export const STREET_H = 6;
/** HQ's width (its column), and one band: north rooms, a street, south rooms (also HQ's height). */
export const HQ_W = 30;
export const BAND_H = ROOM_H + STREET_H + ROOM_H;
/** The dark ring round the building. */
export const MARGIN = 1;
/** The avenue below HQ, and the courts either side of it. */
const AVENUE_W = 6;
const COURT_W = (HQ_W - AVENUE_W) / 2;
/** A street door is two tiles; it sits on rows 2 and 3 of its street (rows 20 and 21 in the classic office). */
const ENTRY_DY = ROOM_H + 2;

export type StreetKind = 'west' | 'east' | 'crossing' | 'avenue';

/** A hall: the west or east street of a band, the crossing below HQ (bands 1 and up), or the avenue. */
export interface Street {
  readonly kind: StreetKind;
  /** Its band (the avenue: 1, the first band it serves). */
  readonly row: number;
  readonly rect: TileRect;
  /** Its outer wall, closed but for the street doors: the outer column of a west or east street, the avenue's last row. */
  readonly wall: TileRect | null;
  /** Where it can be walked: the street without its outer wall. */
  readonly hall: TileRect;
}

export interface Geometry {
  readonly K: number;
  readonly R: number;
  /** The map in tiles, margin included. */
  readonly cols: number;
  readonly rows: number;
  /** HQ's first column, the first column east of HQ, and HQ's centre column. */
  readonly hqX: number;
  readonly eastX: number;
  readonly hqMid: number;
  /** The building without the margin. */
  readonly building: TileRect;
  readonly hqRect: TileRect;
  /** Band by band: west, east, then (from band 1) the crossing; the avenue last when R > 1. */
  readonly streets: readonly Street[];
  /** HQ's west and east doors, plus the south door onto the avenue when R > 1. */
  readonly hqDoors: readonly TileRect[];
  readonly avenue: TileRect | null;
  /** Open ground either side of the avenue: not walkable, not drawn. */
  readonly courts: readonly TileRect[];
  /** Street doors: west and east on every band, then the south gate below the avenue when R > 1. */
  readonly entries: readonly TileRect[];
  /** The tile a walker steps in on, one per entry, in the same order. */
  readonly entryTiles: readonly TilePoint[];
}

const rect = (x: number, y: number, w: number, h: number): TileRect => Object.freeze({ x, y, w, h });
const tile = (tx: number, ty: number): TilePoint => Object.freeze({ tx, ty });
const range = (n: number): readonly number[] => Array.from({ length: n }, (_, i) => i);

/** The first row of a band. */
export function bandY(row: number): number {
  return MARGIN + row * BAND_H;
}

/** The first column of a block: west blocks count outwards from HQ (column 1 touches it), east blocks too. */
export function colX(g: Pick<Geometry, 'K' | 'eastX'>, side: SlotSide, col: number): number {
  return side === 'west' ? MARGIN + (g.K - col) * ROOM_W : g.eastX + (col - 1) * ROOM_W;
}

/** A slot's room rectangle. */
export function roomRectOf(g: Pick<Geometry, 'K' | 'eastX'>, slot: Pick<Slot, 'side' | 'col' | 'row' | 'half'>): TileRect {
  return rect(colX(g, slot.side, slot.col), bandY(slot.row) + (slot.half === 'north' ? 0 : ROOM_H + STREET_H), ROOM_W, ROOM_H);
}

const streetsOf = (K: number, R: number, hqX: number, eastX: number, hqMid: number): readonly Street[] => {
  const span = K * ROOM_W;
  const bands = range(R).flatMap((row): Street[] => {
    const y = bandY(row) + ROOM_H;
    return [
      { kind: 'west', row, rect: rect(MARGIN, y, span, STREET_H), wall: rect(MARGIN, y, 1, STREET_H), hall: rect(MARGIN + 1, y, span - 1, STREET_H) },
      { kind: 'east', row, rect: rect(eastX, y, span, STREET_H), wall: rect(eastX + span - 1, y, 1, STREET_H), hall: rect(eastX, y, span - 1, STREET_H) },
      ...(row > 0 ? [{ kind: 'crossing' as const, row, rect: rect(hqX, y, HQ_W, STREET_H), wall: null, hall: rect(hqX, y, HQ_W, STREET_H) }] : []),
    ];
  });
  if (R === 1) return bands;
  const top = MARGIN + BAND_H;
  const height = (R - 1) * BAND_H;
  const x = hqMid - AVENUE_W / 2;
  const avenue: Street = { kind: 'avenue', row: 1, rect: rect(x, top, AVENUE_W, height), wall: rect(x, top + height - 1, AVENUE_W, 1), hall: rect(x, top, AVENUE_W, height - 1) };
  return [...bands, avenue];
};

const courtsOf = (R: number, hqX: number, hqMid: number): readonly TileRect[] =>
  range(R).slice(1).flatMap((row) => {
    const y = bandY(row);
    const east = hqMid + AVENUE_W / 2;
    return [rect(hqX, y, COURT_W, ROOM_H), rect(east, y, COURT_W, ROOM_H), rect(hqX, y + ROOM_H + STREET_H, COURT_W, ROOM_H), rect(east, y + ROOM_H + STREET_H, COURT_W, ROOM_H)];
  });

const make = (K: number, R: number): Geometry => {
  const cols = 2 * MARGIN + 2 * K * ROOM_W + HQ_W;
  const rows = 2 * MARGIN + R * BAND_H;
  const hqX = MARGIN + K * ROOM_W;
  const eastX = hqX + HQ_W;
  const hqMid = hqX + HQ_W / 2;
  const doorY = bandY(0) + ENTRY_DY;
  const south = R > 1;
  const entries = [
    ...range(R).flatMap((row) => [rect(0, bandY(row) + ENTRY_DY, 2, 2), rect(cols - 2, bandY(row) + ENTRY_DY, 2, 2)]),
    ...(south ? [rect(hqMid - 1, rows - 2, 2, 2)] : []),
  ];
  const entryTiles = [
    ...range(R).flatMap((row) => [tile(0, bandY(row) + ENTRY_DY), tile(cols - 1, bandY(row) + ENTRY_DY + 1)]),
    ...(south ? [tile(hqMid - 1, rows - 1)] : []),
  ];
  const streets = streetsOf(K, R, hqX, eastX, hqMid);
  return Object.freeze({
    K, R, cols, rows, hqX, eastX, hqMid,
    building: rect(MARGIN, MARGIN, cols - 2 * MARGIN, rows - 2 * MARGIN),
    hqRect: rect(hqX, MARGIN, HQ_W, BAND_H),
    streets: Object.freeze(streets.map((s) => Object.freeze(s))),
    hqDoors: Object.freeze([rect(hqX, doorY, 1, 2), rect(eastX - 1, doorY, 1, 2), ...(south ? [rect(hqMid - 1, MARGIN + BAND_H - 1, 2, 1)] : [])]),
    avenue: streets.find((s) => s.kind === 'avenue')?.rect ?? null,
    courts: Object.freeze(courtsOf(R, hqX, hqMid)),
    entries: Object.freeze(entries),
    entryTiles: Object.freeze(entryTiles),
  });
};

const GEOMETRIES = createMemo<Geometry>(8);

/** The geometry of a K × R grid (whole numbers from 1). The same grid always gives back the same frozen geometry. */
export function geometryFor(K: number, R: number): Geometry {
  if (!Number.isInteger(K) || !Number.isInteger(R) || K < 1 || R < 1) throw new RangeError(`a grid needs whole K and R from 1, got ${K} x ${R}`);
  return GEOMETRIES.get(`${K}x${R}`, () => make(K, R));
}

/** The first ring (K = R = 1): the classic four-room office. */
export const FIRST_RING: Geometry = geometryFor(1, 1);

/** The geometry of a map's grid (OfficeMap.grid). */
export function geometryOf(map: { readonly grid: { readonly K: number; readonly R: number } }): Geometry {
  return geometryFor(map.grid.K, map.grid.R);
}

/** How many slots the grid holds after `step` growth steps (shared/pure slots.ts: 4, 8, 16, 24, 36, …); 0 before the first. */
const capacityAtStep = (step: number): number => {
  if (step < 0) return 0;
  const m = Math.floor(step / 2);
  return step % 2 === 0 ? 4 * (m + 1) * (m + 1) : 4 * (m + 1) * (m + 2);
};

/**
 * The slot index of a block's room, the inverse of slotAt (O(1)). Column c and band r first appear in growth step
 * 2(c - 1) - 1 when the column is the newer of the two, else in step 2r; within a column step the slots run band, half,
 * side; within a band step half, column, side (the emit order of shared/pure slots.ts).
 */
export function slotIndexOf(side: SlotSide, col: number, row: number, half: SlotHalf): number {
  if (!Number.isInteger(col) || !Number.isInteger(row) || col < 1 || row < 0) throw new RangeError(`no slot at column ${col}, band ${row}`);
  const s = side === 'west' ? 0 : 1;
  const h = half === 'north' ? 0 : 1;
  const a = col - 1;
  if (a === 0 && row === 0) return h * 2 + s;
  if (a > row) return capacityAtStep(2 * a - 2) + row * 4 + h * 2 + s;
  return capacityAtStep(2 * row - 1) + h * 2 * (row + 1) + a * 2 + s;
}

const within = (n: number, from: number, size: number): boolean => n >= from && n < from + size;

/** The block column under a tile column: its side and column, or null in HQ's column or off the building. */
const blockColumn = (g: Geometry, tx: number): { readonly side: SlotSide; readonly col: number } | null => {
  if (within(tx, MARGIN, g.K * ROOM_W)) return { side: 'west', col: g.K - Math.floor((tx - MARGIN) / ROOM_W) };
  if (within(tx, g.eastX, g.K * ROOM_W)) return { side: 'east', col: Math.floor((tx - g.eastX) / ROOM_W) + 1 };
  return null;
};

/** The half of a band under a tile row, or null on its street or off the building. */
const bandHalf = (g: Geometry, ty: number): { readonly row: number; readonly half: SlotHalf } | null => {
  if (!within(ty, MARGIN, g.R * BAND_H)) return null;
  const row = Math.floor((ty - MARGIN) / BAND_H);
  const dy = ty - bandY(row);
  if (dy < ROOM_H) return { row, half: 'north' };
  return dy >= ROOM_H + STREET_H ? { row, half: 'south' } : null;
};

/** The slot whose room holds a tile, by arithmetic: -2 in HQ, -1 anywhere else (streets, courts, the margin, outside). */
export function slotIndexAt(g: Geometry, tx: number, ty: number): number {
  if (within(tx, g.hqX, HQ_W) && within(ty, MARGIN, BAND_H)) return -2;
  const column = blockColumn(g, tx);
  const band = column === null ? null : bandHalf(g, ty);
  return column === null || band === null ? -1 : slotIndexOf(column.side, column.col, band.row, band.half);
}

/** The slots whose rooms meet a tile rectangle, ascending: O(rooms met), never a scan over every room. */
export function slotsMeeting(g: Geometry, win: TileRect): readonly number[] {
  const x0 = Math.max(win.x, MARGIN);
  const x1 = Math.min(win.x + win.w, g.cols - MARGIN);
  const y0 = Math.max(win.y, MARGIN);
  const y1 = Math.min(win.y + win.h, g.rows - MARGIN);
  if (x1 <= x0 || y1 <= y0) return [];
  const columns: { side: SlotSide; col: number }[] = [];
  const westEnd = Math.min(x1, g.hqX);
  for (let x = x0; x < westEnd; x = MARGIN + (Math.floor((x - MARGIN) / ROOM_W) + 1) * ROOM_W) columns.push({ side: 'west', col: g.K - Math.floor((x - MARGIN) / ROOM_W) });
  for (let x = Math.max(x0, g.eastX); x < x1; x = g.eastX + (Math.floor((x - g.eastX) / ROOM_W) + 1) * ROOM_W) columns.push({ side: 'east', col: Math.floor((x - g.eastX) / ROOM_W) + 1 });
  const halves: { row: number; half: SlotHalf }[] = [];
  for (let row = Math.floor((y0 - MARGIN) / BAND_H); row <= Math.floor((y1 - 1 - MARGIN) / BAND_H); row += 1) {
    const top = bandY(row);
    if (y0 < top + ROOM_H && y1 > top) halves.push({ row, half: 'north' });
    if (y0 < top + BAND_H && y1 > top + ROOM_H + STREET_H) halves.push({ row, half: 'south' });
  }
  return columns.flatMap((c) => halves.map((b) => slotIndexOf(c.side, c.col, b.row, b.half))).toSorted((a, b) => a - b);
}
