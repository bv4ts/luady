import { geometryOf, type Geometry } from '../grid.js';
import { roomsMeeting, type OfficeMap } from '../layout.js';
import { paint, paintWindow, type Painter, type Raster } from '../raster.js';
import { HQ_ID, isEmptySlot, type RoomDef } from '../rooms.js';
import { TILE as T, type PixelRect } from '../types.js';

/**
 * Panes of glass in the building's outer walls (day and night): slits of glass in the west and east walls
 * and in the south wall. The map picture shows them as dark glass (the dusk look); the scene lights them by day and
 * by night, and lays the daylight they let in on the floor.
 */

export type PaneSide = 'west' | 'east' | 'south';
export interface PaneDef {
  /** The room it lights (never an empty slot: those stay dark). */
  readonly room: string;
  readonly side: PaneSide;
  /** The glass, in map pixels. */
  readonly glass: PixelRect;
}

/** Glass is 4 px deep in a 16-px wall and 20 px long. */
const DEPTH = 4;
const LENGTH = 20;
/** Rows (side walls) or columns (south wall) of each pane, counted from the room's top-left tile. */
const SIDE_ROWS = [3, 8, 13] as const;
const SOUTH_COLS = [3, 9, 15, 21] as const;
const HQ_SOUTH_COLS = [3, 8, 19, 24] as const;

const rect = (x: number, y: number, w: number, h: number): PixelRect => Object.freeze({ x, y, w, h });
const meets = (a: PixelRect, b: PixelRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const sideGlass = (room: RoomDef, side: 'west' | 'east', row: number): PixelRect => {
  const wallX = side === 'west' ? room.rect.x * T : (room.rect.x + room.rect.w - 1) * T;
  return rect(wallX + (T - DEPTH) / 2, (room.rect.y + row) * T + (T * 2 - LENGTH) / 2, DEPTH, LENGTH);
};

const southGlass = (room: RoomDef, col: number): PixelRect =>
  rect((room.rect.x + col) * T + (T * 2 - LENGTH) / 2, (room.rect.y + room.rect.h - 1) * T + (T - DEPTH) / 2, LENGTH, DEPTH);

/**
 * A room's panes. Only outer walls have glass: side panes in the rooms of the outermost column (col K), south panes in
 * the south rooms of the last band (row R - 1). HQ keeps its south panes (from the second band on they look onto the
 * courts). At K = R = 1 every room is on the outside, as in the classic office.
 */
const panesOfRoom = (room: RoomDef, g: Geometry): readonly PaneDef[] => {
  if (isEmptySlot(room)) return [];
  const make = (side: PaneSide, glass: PixelRect): PaneDef => Object.freeze({ room: room.id, side, glass });
  if (room.kind === HQ_ID) return HQ_SOUTH_COLS.map((c) => make('south', southGlass(room, c)));
  if (room.slot === null) return [];
  const outer = room.side === 'west' ? 'west' : 'east';
  const side = room.slot.col === g.K;
  const south = room.slot.row === g.R - 1 && room.slot.half === 'south';
  return [
    ...(side ? SIDE_ROWS.map((r) => make(outer, sideGlass(room, outer, r))) : []),
    ...(south ? SOUTH_COLS.map((c) => make('south', southGlass(room, c))) : []),
  ];
};

/** The panes of one room of the map (in its own order). */
export function roomPanes(map: OfficeMap, room: RoomDef): readonly PaneDef[] {
  return panesOfRoom(room, geometryOf(map));
}

const PANES = new WeakMap<OfficeMap, readonly PaneDef[]>();

/** Every pane of the office's lived-in rooms (furnished rooms and HQ), in reading order. */
export function panesOf(map: OfficeMap): readonly PaneDef[] {
  const known = PANES.get(map);
  if (known !== undefined) return known;
  const g = geometryOf(map);
  const made = Object.freeze(map.order.flatMap((key) => {
    const room = map.rooms[key];
    return room === undefined ? [] : panesOfRoom(room, g);
  }));
  PANES.set(map, made);
  return made;
}

/** How far daylight reaches into a room from a pane, and how it slants (the sun stands south-west). */
const REACH = 44;
const SLANT = 0.5;

/** One patch of daylight on the floor: the pane shape cast inwards, solid near the glass, dithered further in, kept on the room's floor. */
const castPatch = (p: Painter, w: PaneDef, floor: PixelRect): void => {
  const g = w.glass;
  const put = (x: number, y: number, colour: string): void => {
    if (x >= floor.x && x < floor.x + floor.w && y >= floor.y && y < floor.y + floor.h) p.put(x, y, colour);
  };
  for (let d = 0; d < REACH; d += 1) {
    const level = d < REACH * 0.45 ? 2 : 1;
    const shift = Math.round(d * SLANT);
    for (let i = 0; i < LENGTH; i += 1) {
      if (level === 1 && (d + i) % 2 === 1) continue;
      const colour = level === 2 ? '#ffffff' : '#9a9a9a';
      if (w.side === 'west') put(g.x + g.w + 6 + d, g.y + i + shift, colour);
      else if (w.side === 'east') put(g.x - 6 - d, g.y + i + shift, colour);
      else put(g.x + i - shift, g.y - 6 - d, colour);
    }
  }
};

/** A room's floor: inside its side and front walls, below its back wall. */
const floorOf = (room: RoomDef): PixelRect =>
  rect((room.rect.x + 1) * T, (room.rect.y + 2) * T, (room.rect.w - 2) * T, (room.rect.h - 3) * T);

/** The furthest a patch slants sideways, in pixels. */
const SHIFT_MAX = Math.round((REACH - 1) * SLANT);

/** Exactly the pixels castPatch can reach from a pane, before the floor clips them. */
const reachOf = (w: PaneDef): PixelRect => {
  const g = w.glass;
  if (w.side === 'west') return rect(g.x + g.w + 6, g.y, REACH, LENGTH + SHIFT_MAX);
  if (w.side === 'east') return rect(g.x - 5 - REACH, g.y, REACH, LENGTH + SHIFT_MAX);
  return rect(g.x - SHIFT_MAX, g.y - 5 - REACH, LENGTH + SHIFT_MAX, REACH);
};

const clip = (a: PixelRect, b: PixelRect): PixelRect | null => {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? rect(x0, y0, x1 - x0, y1 - y0) : null;
};

/** Where a pane's daylight can fall: its reach kept on its room's floor; null when it lights no floor. */
const castBox = (w: PaneDef, room: RoomDef): PixelRect | null => clip(reachOf(w), floorOf(room));

/**
 * Paints the daylight of the office's panes in map pixels. With `cull`, only the panes whose cast box meets it (found
 * through the rooms meeting it, never a scan over every room); the pixels inside `cull` are the same either way.
 */
export function drawDaylight(p: Painter, map: OfficeMap, cull?: PixelRect): void {
  const g = geometryOf(map);
  const rooms = cull === undefined ? map.order.flatMap((key) => map.rooms[key] ?? []) : roomsMeeting(map, cull);
  rooms.forEach((room) => panesOfRoom(room, g).forEach((w) => {
    if (cull !== undefined) {
      const box = castBox(w, room);
      if (box === null || !meets(box, cull)) return;
    }
    castPatch(p, w, floorOf(room));
  }));
}

/**
 * Where daylight falls on the floors, map-sized: white near the panes, dithered grey further in, transparent
 * elsewhere. The scene tints it warm and adds it to the picture by day. Full size: the oracle of the daylight chunks
 * (the scene paints chunks, see chunkRaster).
 */
export function daylightRaster(map: OfficeMap): Raster {
  return paint(map.width, map.height, (p) => drawDaylight(p, map));
}

/** The daylight of a frame of the map, in map pixels (a chunk, cropped): never larger than the frame. */
export function daylightWindow(map: OfficeMap, win: PixelRect): Raster {
  return paintWindow(win, (p) => drawDaylight(p, map, win));
}

/**
 * Where each pane's daylight can fall, in map pixels: the glass grown by REACH + 6 inwards and slanted, kept on its
 * room's floor (pure geometry). One box per pane that lights any floor.
 */
export function daylightBoxes(map: OfficeMap): readonly PixelRect[] {
  return Object.freeze(panesOf(map).flatMap((w) => {
    const room = map.rooms[w.room];
    const box = room === undefined ? null : castBox(w, room);
    return box === null ? [] : [box];
  }));
}

/** True when some pane's cast box meets the frame: found through the rooms meeting it (chunkLayers). */
export function daylightMeets(map: OfficeMap, win: PixelRect): boolean {
  const g = geometryOf(map);
  return roomsMeeting(map, win).some((room) => panesOfRoom(room, g).some((w) => {
    const box = castBox(w, room);
    return box !== null && meets(box, win);
  }));
}

/**
 * A soft pool of light, white at the middle and dithered towards the edge (three rings), `2rx + 1` by `2ry + 1`.
 * The scene tints it and adds it: under the lamps at night, and round the panes outside.
 */
export function glowPoolRaster(rx: number, ry: number): Raster {
  return paint(rx * 2 + 1, ry * 2 + 1, (p) => {
    for (let y = -ry; y <= ry; y += 1) {
      for (let x = -rx; x <= rx; x += 1) {
        const e = (x * x) / (rx * rx) + (y * y) / (ry * ry);
        if (e > 1) continue;
        if (e < 0.25) p.put(x + rx, y + ry, '#ffffff');
        else if (e < 0.6) p.put(x + rx, y + ry, '#a0a0a0');
        else if ((x + y) % 2 === 0) p.put(x + rx, y + ry, '#5a5a5a');
      }
    }
  });
}
