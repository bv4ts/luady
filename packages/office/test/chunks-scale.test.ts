import { describe, expect, it } from 'vitest';
import type { RoomDTO } from '@luady/shared';
import {
  CHUNK_LAYERS, chunkKey, chunkLayers, chunkPlacement, chunkRaster, chunkRect, chunkWorldRect, layerExtent, type ChunkLayer,
} from '../src/chunks.js';
import { buildOffice, roomRectPx, type OfficeMap } from '../src/layout.js';
import { createRaster, paintWindow, rasterHighWater, resetRasterHighWater, type Raster } from '../src/raster.js';
import { isFurnished } from '../src/rooms.js';
import { EXTERIOR_MARGIN, drawExterior, exteriorRaster, lampFeet } from '../src/sprites/exterior.js';
import { groundRaster } from '../src/sprites/ground.js';
import { withLampLight } from '../src/sprites/lamp-light.js';
import { drawMap, mapLayerRaster } from '../src/sprites/map-layer.js';
import { daylightRaster, drawDaylight } from '../src/sprites/panes.js';
import type { PixelRect } from '../src/types.js';
import { rooms } from './rooms-fixture.js';
import { seeded } from './seeded.js';

/** Every third furnished room hangs a Jira board. */
const jiraOf = (map: OfficeMap): { readonly jiraRooms: readonly string[] } =>
  ({ jiraRooms: map.order.filter((k) => isFurnished(map.rooms[k]!)).filter((_, i) => i % 3 === 0) });

const chunksOf = (map: OfficeMap): readonly (readonly [number, number])[] =>
  Array.from({ length: map.chunks.cols * map.chunks.rows }, (_, k) => [k % map.chunks.cols, Math.floor(k / map.chunks.cols)] as const);

const same = (a: Raster, b: Raster): boolean => a.width === b.width && a.height === b.height && Buffer.from(a.data).equals(Buffer.from(b.data));

const opaque = (r: Raster): boolean => {
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] !== 0) return true;
  return false;
};

const fullOf = (map: OfficeMap, layer: ChunkLayer): Raster =>
  layer === 'map' ? mapLayerRaster(map, jiraOf(map)) : layer === 'daylight' ? daylightRaster(map) : exteriorRaster(map);

/** Every chunk of a layer copied (not blended) into a raster of the layer's extent. */
const stitch = (map: OfficeMap, layer: ChunkLayer): Raster => {
  const extent = layerExtent(map, layer);
  const out = createRaster(extent.w, extent.h);
  chunksOf(map).forEach(([i, j]) => {
    const r = chunkRaster(map, layer, i, j, jiraOf(map));
    const at = chunkPlacement(map, layer, i, j);
    for (let y = 0; y < r.height; y += 1) out.data.set(r.data.subarray(y * r.width * 4, (y + 1) * r.width * 4), ((at.y + y) * extent.w + at.x) * 4);
  });
  return out;
};

/**
 * The oracle of one chunk without any full raster: the layer's whole drawing (no culling) painted into the chunk's
 * cropped frame, and for the garden the light of every lamp.
 */
const fullDrawOf = (map: OfficeMap, layer: ChunkLayer, at: PixelRect): Raster => {
  if (layer === 'map') return paintWindow(at, (p) => drawMap(p, map, jiraOf(map)));
  if (layer === 'daylight') return paintWindow(at, (p) => drawDaylight(p, map));
  const frame = { x: at.x + EXTERIOR_MARGIN, y: at.y + EXTERIOR_MARGIN, w: at.w, h: at.h };
  const building = { x: map.zones.all.x + EXTERIOR_MARGIN, y: map.zones.all.y + EXTERIOR_MARGIN, w: map.zones.all.w, h: map.zones.all.h };
  return withLampLight(paintWindow(frame, (p) => drawExterior(p, map)), groundRaster(), lampFeet(map), building, frame);
};

describe.each([0, 1, 4, 5, 24])('the chunks of an office of %i rooms', (n) => {
  const map = buildOffice(rooms(n));

  it.each(CHUNK_LAYERS)('stitch back into the full %s raster, byte for byte', (layer) => {
    const full = fullOf(map, layer);
    expect(same(stitch(map, layer), full)).toBe(true);
  });

  it('are at most 512 px on either side, the size of their cropped world rectangle', () => {
    resetRasterHighWater();
    chunksOf(map).forEach(([i, j]) => CHUNK_LAYERS.forEach((layer) => {
      const r = chunkRaster(map, layer, i, j, jiraOf(map));
      const at = chunkWorldRect(map, layer, i, j);
      expect([r.width, r.height]).toEqual([at.w, at.h]);
    }));
    expect(rasterHighWater()).toBeLessThanOrEqual(512);
  });
});

describe.each([4, 24])('chunkLayers at %i rooms', (n) => {
  it('lists a layer for a chunk exactly when that chunk has a visible pixel of it (checked on every chunk)', () => {
    const map = buildOffice(rooms(n));
    chunksOf(map).forEach(([i, j]) => {
      const listed = chunkLayers(map, i, j);
      CHUNK_LAYERS.forEach((layer) => expect([i, j, layer, listed.has(layer)]).toEqual([i, j, layer, opaque(chunkRaster(map, layer, i, j, jiraOf(map)))]));
    });
  });
});

describe.each([100, 300])('the chunks of an office of %i rooms', (n) => {
  const map = buildOffice(rooms(n));

  it('are 30 seeded random chunks equal to the whole drawing painted in their frame, with no raster over 512 px built', () => {
    const random = seeded(n);
    resetRasterHighWater();
    for (let k = 0; k < 30; k += 1) {
      const i = Math.floor(random() * map.chunks.cols);
      const j = Math.floor(random() * map.chunks.rows);
      CHUNK_LAYERS.forEach((layer) => {
        const at = chunkWorldRect(map, layer, i, j);
        if (at.w === 0) return;
        expect([i, j, layer, same(chunkRaster(map, layer, i, j, jiraOf(map)), fullDrawOf(map, layer, at))]).toEqual([i, j, layer, true]);
      });
    }
    expect(rasterHighWater()).toBeLessThanOrEqual(512);
  });

  it('crop every chunk to at most 512 px on either side', () => {
    chunksOf(map).forEach(([i, j]) => CHUNK_LAYERS.forEach((layer) => {
      const at = chunkWorldRect(map, layer, i, j);
      expect(Math.max(at.w, at.h)).toBeLessThanOrEqual(512);
    }));
  });
});

describe('chunkKey at scale', () => {
  const keys = (m: OfficeMap, layer: ChunkLayer, options = jiraOf(m)): readonly string[] => chunksOf(m).map(([i, j]) => chunkKey(m, layer, i, j, options));
  const meetingRoom = (m: OfficeMap, id: string): readonly string[] =>
    chunksOf(m).filter(([i, j]) => {
      const a = chunkRect(m, i, j);
      const b = roomRectPx(m.rooms[id]!);
      return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    }).map(([i, j]) => `${i},${j}`);
  const changed = (m: OfficeMap, a: readonly string[], b: readonly string[]): readonly string[] =>
    chunksOf(m).filter((_, k) => a[k] !== b[k]).map(([i, j]) => `${i},${j}`);

  it.each([24, 300])('at %i rooms differs between chunks and layers, and changes for a recoloured room only where it meets the chunk', (n) => {
    const input = rooms(n);
    const map = buildOffice(input);
    const all = CHUNK_LAYERS.flatMap((l) => keys(map, l));
    expect(new Set(all).size).toBe(all.length);
    const target = input[Math.floor(n / 2)]!.id;
    const recoloured = buildOffice(input.map((r): RoomDTO => (r.id === target ? { ...r, colour: '#d6336c' } : r)));
    expect(changed(map, keys(map, 'map'), keys(recoloured, 'map'))).toEqual(meetingRoom(map, target));
    expect(keys(recoloured, 'daylight')).toEqual(keys(map, 'daylight'));
    expect(keys(recoloured, 'exterior')).toEqual(keys(map, 'exterior'));
  });

  it('changes, for a room added into a lot of the same grid, only the chunks that room meets', () => {
    const map = buildOffice(rooms(290));
    const more = buildOffice(rooms(291));
    expect(more.grid).toMatchObject({ K: map.grid.K, R: map.grid.R });
    const meeting = meetingRoom(more, rooms(291)[290]!.id);
    expect(changed(map, keys(map, 'map'), keys(more, 'map'))).toEqual(meeting);
    changed(map, keys(map, 'daylight'), keys(more, 'daylight')).forEach((c) => expect(meeting).toContain(c));
    expect(keys(more, 'exterior')).toEqual(keys(map, 'exterior'));
  });

  it('is short at any size: no longer than the rooms meeting the chunk need', () => {
    const map = buildOffice(rooms(300));
    expect(Math.max(...keys(map, 'map').map((k) => k.length))).toBeLessThan(1500);
    expect(Math.max(...keys(map, 'exterior').map((k) => k.length))).toBeLessThan(40);
  });
});
