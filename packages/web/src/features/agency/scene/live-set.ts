import {
  CHUNK_LAYERS, HQ_ID, ROOM_H, ROOM_W, TILE, chunkLayers, chunkWorldRect, roomsMeeting,
  type ChunkLayer, type OfficeMap, type PixelPoint, type PixelRect, type RoomDef,
} from '@luady/office';

/**
 * What the scene keeps alive for a view: the chunks to draw, the rooms that get their own display
 * objects, the level of detail and far mode. Pure: geometry only, nothing is painted. The view is the world rectangle
 * the stage shows, in map pixels; margins are CSS pixels, so they shrink in the world as the zoom grows.
 */

export type Lod = 1 | 2 | 4 | 8;

/** Chunks meeting the view grown by this many CSS pixels are drawn (and painted). */
export const CHUNK_MARGIN_CSS = 192;
/** A chunk's textures are kept while it meets the view grown by twice the margin; released 2 s after leaving it. */
export const KEEP_MARGIN_CSS = CHUNK_MARGIN_CSS * 2;
/** Below this zoom the office is drawn in far mode. */
export const FAR_SCALE = 0.45;
/** More live rooms than this, and the office is drawn in far mode whatever the zoom. */
export const FAR_ROOMS = 80;
/** In far mode the HUD badges at most this many rooms, the nearest the view centre. */
export const FAR_BADGES = 300;
/**
 * How much the view grows on each side when the live rooms are counted: half a room, so the view grows by one room
 * along each axis. That gives "about 75 rooms at 1440×900 and scale 0.45" (the most
 * found over every pan is 72); a whole room on each side would give 90 there and push the e2e viewport into far mode.
 */
export const ROOM_REACH: Readonly<{ x: number; y: number }> = Object.freeze({ x: (ROOM_W * TILE) / 2, y: (ROOM_H * TILE) / 2 });

/** The level of detail for a zoom: 1 at 0.75 and closer, 2 from 0.45, 4 from 0.225, else 8. */
export function lodFor(scale: number): Lod {
  if (scale >= 0.75) return 1;
  if (scale >= 0.45) return 2;
  return scale >= 0.225 ? 4 : 8;
}

/** A rectangle grown by `x` on its left and right and `y` on its top and bottom. */
export function grow(r: PixelRect, x: number, y: number = x): PixelRect {
  return Object.freeze({ x: r.x - x, y: r.y - y, w: r.w + x * 2, h: r.h + y * 2 });
}

const meets = (a: PixelRect, b: PixelRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** One live chunk: its grid cell and how far its centre lies from the view centre (map pixels). */
export interface LiveChunk { readonly i: number; readonly j: number; readonly distance: number }

/**
 * The chunks meeting the view grown by `marginCss` CSS pixels (CHUNK_MARGIN_CSS unless given), nearest the centre
 * first. O(chunks met): the cells come from the rectangle by arithmetic.
 */
export function liveChunks(map: OfficeMap, view: PixelRect, scale: number, centre: PixelPoint, marginCss = CHUNK_MARGIN_CSS): readonly LiveChunk[] {
  const reach = grow(view, marginCss / Math.max(scale, 1e-6));
  const { origin, size, cols, rows } = map.chunks;
  const i0 = Math.max(0, Math.floor((reach.x - origin.x) / size));
  const j0 = Math.max(0, Math.floor((reach.y - origin.y) / size));
  const i1 = Math.min(cols - 1, Math.ceil((reach.x + reach.w - origin.x) / size) - 1);
  const j1 = Math.min(rows - 1, Math.ceil((reach.y + reach.h - origin.y) / size) - 1);
  const out: LiveChunk[] = [];
  for (let j = j0; j <= j1; j += 1) {
    for (let i = i0; i <= i1; i += 1) {
      const cx = origin.x + size * (i + 0.5);
      const cy = origin.y + size * (j + 0.5);
      out.push({ i, j, distance: Math.hypot(cx - centre.x, cy - centre.y) });
    }
  }
  return out.sort((a, b) => a.distance - b.distance || a.j - b.j || a.i - b.i);
}

/**
 * The rooms that get their own display objects: rooms and lots meeting the view grown by one room (ROOM_REACH on every
 * side), in map order. HQ is not among them: its objects are part of the fixed share (the "+ 200").
 */
export function liveRooms(map: OfficeMap, view: PixelRect): readonly RoomDef[] {
  return roomsMeeting(map, grow(view, ROOM_REACH.x, ROOM_REACH.y)).filter((r) => r.id !== HQ_ID);
}

/** True for far mode: zoomed out below FAR_SCALE, or more than FAR_ROOMS live rooms. */
export function isFar(scale: number, live: readonly unknown[]): boolean {
  return scale < FAR_SCALE || live.length > FAR_ROOMS;
}

/** GPU bytes of one chunk texture of a layer at a lod: its cropped rectangle (chunkWorldRect) shrunk, 4 bytes a pixel. */
export function chunkBytes(map: OfficeMap, layer: ChunkLayer, i: number, j: number, lod: Lod): number {
  const r = chunkWorldRect(map, layer, i, j);
  return Math.ceil(r.w / lod) * Math.ceil(r.h / lod) * 4;
}

const LAYERS = new WeakMap<OfficeMap, (readonly ChunkLayer[] | undefined)[]>();

/** The layers a chunk draws, in drawing order: only those chunkLayers says have pixels there (worked out once per map and chunk). */
export function layersOf(map: OfficeMap, i: number, j: number): readonly ChunkLayer[] {
  const { cols, rows } = map.chunks;
  if (i < 0 || j < 0 || i >= cols || j >= rows) return [];
  let known = LAYERS.get(map);
  if (known === undefined) {
    known = [];
    LAYERS.set(map, known);
  }
  const at = j * cols + i;
  const cached = known[at];
  if (cached !== undefined) return cached;
  const present = chunkLayers(map, i, j);
  const made = Object.freeze(CHUNK_LAYERS.filter((layer) => present.has(layer)));
  known[at] = made;
  return made;
}

const MIB = 1024 * 1024;

/** The chunk texture budget for a stage of `width × height` CSS pixels: 33 MiB + 46 B per CSS pixel. */
export function chunkBudget(width: number, height: number): number {
  return 33 * MIB + 46 * Math.max(0, width) * Math.max(0, height);
}

/** The display-object bound of detailed mode: live rooms × (90 + 6 × seated per room) + 200. */
export function objectBound(live: number, seatedPerRoom: number): number {
  return live * (90 + 6 * seatedPerRoom) + 200;
}

/** Everything the layers draw for one view, worked out once per change of view or map. */
export interface LiveView {
  /** The world rectangle the stage shows, in map pixels. */
  readonly rect: PixelRect;
  readonly scale: number;
  readonly centre: PixelPoint;
  readonly lod: Lod;
  readonly far: boolean;
  /** Chunks to draw: the view grown by CHUNK_MARGIN_CSS, nearest first. */
  readonly chunks: readonly LiveChunk[];
  /** Chunks whose textures are kept: the view grown by KEEP_MARGIN_CSS. */
  readonly ring: readonly LiveChunk[];
  /** The live rooms (liveRooms): what far mode counts. */
  readonly live: readonly RoomDef[];
  /** The rooms that get their own display objects now: the live rooms and HQ when it meets; none in far mode. */
  readonly rooms: ReadonlySet<string>;
  /** The area outside rooms (streets, garden) whose furniture is drawn: the view grown like the live rooms. */
  readonly reach: PixelRect;
  /** The area whose lamps and panes are drawn: the chunk area. */
  readonly area: PixelRect;
}

/** The live view of a map for a stage view (world rectangle, zoom and centre). */
export function liveView(map: OfficeMap, rect: PixelRect, scale: number, centre: PixelPoint): LiveView {
  const live = liveRooms(map, rect);
  const far = isFar(scale, live);
  const reach = grow(rect, ROOM_REACH.x, ROOM_REACH.y);
  const hq = map.rooms[HQ_ID];
  const hqMeets = hq !== undefined && meets(reach, { x: hq.rect.x * TILE, y: hq.rect.y * TILE, w: hq.rect.w * TILE, h: hq.rect.h * TILE });
  const rooms = far ? new Set<string>() : new Set([...live.map((r) => r.id), ...(hqMeets ? [HQ_ID] : [])]);
  return Object.freeze({
    rect, scale, centre, lod: lodFor(scale), far,
    chunks: liveChunks(map, rect, scale, centre, CHUNK_MARGIN_CSS),
    ring: liveChunks(map, rect, scale, centre, KEEP_MARGIN_CSS),
    live, rooms, reach, area: grow(rect, CHUNK_MARGIN_CSS / Math.max(scale, 1e-6)),
  });
}

/** True when a world point lies in a rectangle. */
export function contains(r: PixelRect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
}

/** True when two rectangles overlap. */
export function overlaps(a: PixelRect, b: PixelRect): boolean {
  return meets(a, b);
}
