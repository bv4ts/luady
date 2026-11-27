import type { FixtureOptions } from './fixtures.js';
import { BAND_H, MARGIN, ROOM_W, geometryOf } from './grid.js';
import { roomsMeeting, type OfficeMap } from './layout.js';
import { createRaster, type Raster } from './raster.js';
import { isFurnished, visualKeyOf, type RoomDef } from './rooms.js';
import { EXTERIOR_MARGIN, exteriorFrame } from './sprites/exterior.js';
import { mapLayerWindow } from './sprites/map-layer.js';
import { daylightMeets, daylightWindow } from './sprites/panes.js';
import { TILE, type PixelPoint, type PixelRect, type TileRect } from './types.js';

/**
 * Map-sized pictures cut into chunks of at most 512 px. Every layer shares one chunk grid whose
 * origin is the exterior's corner; a layer's chunk raster is the chunk's frame cropped to that layer's own extent:
 * `map` and `daylight` cover the map, `exterior` the map grown by EXTERIOR_MARGIN on every side. Stitching every chunk
 * of a layer at its chunkPlacement gives back the layer's full raster byte for byte.
 *
 * A chunk is painted from its frame alone: the rooms, streets, doors and panes that meet it (found by slot
 * arithmetic), the garden things of its cell, and the lamps whose light reaches it. No code path here builds a
 * map-sized raster; the full rasters (mapLayerRaster, daylightRaster, exteriorRaster) are the tests' oracles.
 */
export type ChunkLayer = 'map' | 'daylight' | 'exterior';
export const CHUNK_LAYERS: readonly ChunkLayer[] = Object.freeze(['map', 'daylight', 'exterior'] as const);

/** What a map chunk depends on besides the map: the rooms that hang a Jira board. */
export type ChunkOptions = FixtureOptions;

const rect = (x: number, y: number, w: number, h: number): PixelRect => Object.freeze({ x, y, w, h });
const px = (r: TileRect): PixelRect => rect(r.x * TILE, r.y * TILE, r.w * TILE, r.h * TILE);

const meets = (a: PixelRect, b: PixelRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const contains = (outer: PixelRect, inner: PixelRect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;

/** True for a chunk of the map's grid. */
export function hasChunk(map: OfficeMap, i: number, j: number): boolean {
  return Number.isInteger(i) && Number.isInteger(j) && i >= 0 && j >= 0 && i < map.chunks.cols && j < map.chunks.rows;
}

/** The chunk's frame in world (map) pixels, before cropping: what the scene culls with. */
export function chunkRect(map: OfficeMap, i: number, j: number): PixelRect {
  const { origin, size } = map.chunks;
  return rect(origin.x + size * i, origin.y + size * j, size, size);
}

/** Where a layer has pixels, in world pixels. */
export function layerExtent(map: OfficeMap, layer: ChunkLayer): PixelRect {
  return layer === 'exterior'
    ? rect(-EXTERIOR_MARGIN, -EXTERIOR_MARGIN, map.width + EXTERIOR_MARGIN * 2, map.height + EXTERIOR_MARGIN * 2)
    : rect(0, 0, map.width, map.height);
}

/** The chunk's frame cropped to the layer's extent, in world pixels (empty, w = h = 0, off the extent or the grid). */
export function chunkWorldRect(map: OfficeMap, layer: ChunkLayer, i: number, j: number): PixelRect {
  const win = chunkRect(map, i, j);
  const extent = layerExtent(map, layer);
  const x0 = Math.max(win.x, extent.x);
  const y0 = Math.max(win.y, extent.y);
  const x1 = Math.min(win.x + win.w, extent.x + extent.w);
  const y1 = Math.min(win.y + win.h, extent.y + extent.h);
  return hasChunk(map, i, j) && x1 > x0 && y1 > y0 ? rect(x0, y0, x1 - x0, y1 - y0) : rect(x0, y0, 0, 0);
}

/** Where the chunk raster lands in the layer's full raster: `(max(chunkX, extentX) - extentX, max(chunkY, extentY) - extentY)`. */
export function chunkPlacement(map: OfficeMap, layer: ChunkLayer, i: number, j: number): PixelPoint {
  const win = chunkRect(map, i, j);
  const extent = layerExtent(map, layer);
  return Object.freeze({ x: Math.max(win.x, extent.x) - extent.x, y: Math.max(win.y, extent.y) - extent.y });
}

/**
 * What the map layer covers, every pixel opaque: the west and east blocks (rooms and lots with their streets), HQ, the
 * crossings and the avenue below it, and the street doors. Only the courts inside the building stay transparent.
 */
const buildingParts = (map: OfficeMap): readonly PixelRect[] => {
  const g = geometryOf(map);
  const blocks = [rect(MARGIN, MARGIN, g.K * ROOM_W, g.R * BAND_H), rect(g.eastX, MARGIN, g.K * ROOM_W, g.R * BAND_H)];
  const centre = g.streets.filter((s) => s.kind === 'crossing' || s.kind === 'avenue').map((s) => s.rect);
  return [...blocks, g.hqRect, ...centre, ...g.entries].map(px);
};

/**
 * The layers that have something in this chunk, from geometry alone: `map` where the frame meets the building's
 * drawn parts, `exterior` unless the frame lies wholly inside the building (the garden is transparent there),
 * `daylight` where a pane's cast box meets it. Empty off the grid.
 */
export function chunkLayers(map: OfficeMap, i: number, j: number): ReadonlySet<ChunkLayer> {
  const layers = new Set<ChunkLayer>();
  if (!hasChunk(map, i, j)) return layers;
  const win = chunkRect(map, i, j);
  if (buildingParts(map).some((part) => meets(part, win))) layers.add('map');
  if (!contains(map.zones.all, win)) layers.add('exterior');
  if (daylightMeets(map, win)) layers.add('daylight');
  return layers;
}

const JIRA_SETS = new WeakMap<readonly string[], ReadonlySet<string>>();

const jiraSet = (options: ChunkOptions | undefined): ReadonlySet<string> => {
  const named = options?.jiraRooms ?? [];
  const known = JIRA_SETS.get(named);
  if (known !== undefined) return known;
  const made = new Set(named);
  JIRA_SETS.set(named, made);
  return made;
};

/** What of a room decides a chunk's pixels: its id and kind, its slot (so its rectangle, panes and template). */
const placeOf = (room: RoomDef): string => `${room.id}:${room.kind}:${room.slot?.index ?? '-'}`;

/**
 * A key that changes whenever the chunk's pixels may change, without painting. Every layer's key holds the layer, the
 * grid (K and R: the geometry of streets, doors, HQ and the garden) and the chunk. The garden follows the grid alone;
 * daylight adds each room meeting the frame (where it is and whether it is lived in); the map adds each such room's
 * look (visualKeyOf) and which of them hang a Jira board. So a change to one room repaints only the chunks that room
 * meets, and the key stays short at any number of rooms. O(rooms met).
 */
export function chunkKey(map: OfficeMap, layer: ChunkLayer, i: number, j: number, options?: ChunkOptions): string {
  const base = `${layer}|K${map.grid.K}R${map.grid.R}|${i},${j}`;
  if (layer === 'exterior' || !hasChunk(map, i, j)) return base;
  const rooms = roomsMeeting(map, chunkRect(map, i, j));
  if (layer === 'daylight') return `${base}|${rooms.map(placeOf).join(',')}`;
  const jira = jiraSet(options);
  const hung = rooms.filter((r) => isFurnished(r) && jira.has(r.id)).map((r) => r.id);
  return `${base}|${rooms.map((r) => `${placeOf(r)}=${visualKeyOf(r)}`).join(',')}|${hung.join(',')}`;
}

const EMPTY = createRaster(0, 0);

/**
 * One chunk of a layer, cropped to the layer's extent (at most 512 px on each side), painted from its frame alone;
 * 0 × 0 off the grid or the extent.
 */
export function chunkRaster(map: OfficeMap, layer: ChunkLayer, i: number, j: number, options?: ChunkOptions): Raster {
  const at = chunkWorldRect(map, layer, i, j);
  if (at.w === 0 || at.h === 0) return EMPTY;
  if (layer === 'map') return mapLayerWindow(map, at, options);
  if (layer === 'daylight') return daylightWindow(map, at);
  return exteriorFrame(map, rect(at.x + EXTERIOR_MARGIN, at.y + EXTERIOR_MARGIN, at.w, at.h));
}
