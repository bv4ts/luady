import { describe, expect, it } from 'vitest';
import type { RoomDTO } from '@luady/shared';
import { CLASSIC_ROOMS } from './rooms-fixture.js';
import { CHUNK_PX } from '../src/chunk-grid.js';
import {
  CHUNK_LAYERS, chunkKey, chunkLayers, chunkPlacement, chunkRaster, chunkRect, chunkWorldRect, layerExtent, type ChunkLayer,
} from '../src/chunks.js';
import { buildOffice, type OfficeMap } from '../src/layout.js';
import { createRaster, downsample, paint, pixelAt, type Raster } from '../src/raster.js';
import { exteriorRaster } from '../src/sprites/exterior.js';
import { mapLayerRaster } from '../src/sprites/map-layer.js';
import { daylightRaster } from '../src/sprites/panes.js';
import { rooms } from './rooms-fixture.js';

const MIB = 1024 * 1024;
const JIRA = { jiraRooms: ['ash', 'cedar'] };

const fullOf = (map: OfficeMap, layer: ChunkLayer): Raster =>
  layer === 'map' ? mapLayerRaster(map, JIRA) : layer === 'daylight' ? daylightRaster(map) : exteriorRaster(map);

const chunksOf = (map: OfficeMap): readonly (readonly [number, number])[] =>
  Array.from({ length: map.chunks.cols * map.chunks.rows }, (_, k) => [k % map.chunks.cols, Math.floor(k / map.chunks.cols)] as const);

/** Every chunk of a layer copied (not blended) into a raster of the layer's extent. */
const stitch = (map: OfficeMap, layer: ChunkLayer): Raster => {
  const extent = layerExtent(map, layer);
  const out = createRaster(extent.w, extent.h);
  chunksOf(map).forEach(([i, j]) => {
    const r = chunkRaster(map, layer, i, j, JIRA);
    const at = chunkPlacement(map, layer, i, j);
    for (let y = 0; y < r.height; y += 1) out.data.set(r.data.subarray(y * r.width * 4, (y + 1) * r.width * 4), ((at.y + y) * extent.w + at.x) * 4);
  });
  return out;
};

/** Byte equality of two rasters (vitest's deep equality is slow on large typed arrays). */
const same = (a: Raster, b: Raster): boolean => a.width === b.width && a.height === b.height && Buffer.from(a.data).equals(Buffer.from(b.data));

const opaque = (r: Raster): boolean => {
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] !== 0) return true;
  return false;
};

const OFFICES: readonly (readonly [string, readonly RoomDTO[]])[] = [
  ['the classic four', CLASSIC_ROOMS], ['no rooms', []], ['one room', rooms(1)],
];

describe('chunk geometry', () => {
  const map = buildOffice(CLASSIC_ROOMS);

  it('lays one 512-px grid from the exterior corner over the exterior', () => {
    expect(CHUNK_PX).toBe(512);
    expect(map.chunks).toEqual({ origin: { x: -320, y: -320 }, size: 512, cols: 4, rows: 3 });
    expect(chunkRect(map, 0, 0)).toEqual({ x: -320, y: -320, w: 512, h: 512 });
    expect(chunkRect(map, 3, 2)).toEqual({ x: 1216, y: 704, w: 512, h: 512 });
  });

  it('crops each layer to its extent and places it by the chunk placement formula', () => {
    expect(layerExtent(map, 'map')).toEqual({ x: 0, y: 0, w: 1344, h: 672 });
    expect(layerExtent(map, 'exterior')).toEqual({ x: -320, y: -320, w: 1984, h: 1312 });
    expect(chunkWorldRect(map, 'map', 0, 0)).toEqual({ x: 0, y: 0, w: 192, h: 192 });
    expect(chunkWorldRect(map, 'map', 2, 1)).toEqual({ x: 704, y: 192, w: 512, h: 480 });
    expect(chunkWorldRect(map, 'map', 3, 1)).toEqual({ x: 1216, y: 192, w: 128, h: 480 });
    expect(chunkWorldRect(map, 'map', 1, 2)).toMatchObject({ w: 0, h: 0 });
    expect(chunkWorldRect(map, 'exterior', 3, 2)).toEqual({ x: 1216, y: 704, w: 448, h: 288 });
    chunksOf(map).forEach(([i, j]) => CHUNK_LAYERS.forEach((layer) => {
      const win = chunkRect(map, i, j);
      const extent = layerExtent(map, layer);
      expect(chunkPlacement(map, layer, i, j)).toEqual({ x: Math.max(win.x, extent.x) - extent.x, y: Math.max(win.y, extent.y) - extent.y });
    }));
  });

  it('has nothing off the grid', () => {
    [[-1, 0], [0, -1], [4, 0], [0, 3], [0.5, 1]].forEach(([i = 0, j = 0]) => {
      expect(chunkLayers(map, i, j).size).toBe(0);
      expect(chunkWorldRect(map, 'exterior', i, j)).toMatchObject({ w: 0, h: 0 });
      expect([chunkRaster(map, 'exterior', i, j).width, chunkRaster(map, 'exterior', i, j).height]).toEqual([0, 0]);
    });
  });
});

describe.each(OFFICES)('chunk rasters of %s', (_name, input) => {
  const map = buildOffice(input);

  it.each(CHUNK_LAYERS)('stitch back into the full %s raster, byte for byte', (layer) => {
    const full = fullOf(map, layer);
    const stitched = stitch(map, layer);
    expect([stitched.width, stitched.height]).toEqual([full.width, full.height]);
    expect(same(stitched, full)).toBe(true);
  });

  it('are at most 512 px on either side and as large as their cropped world rectangle', () => {
    chunksOf(map).forEach(([i, j]) => CHUNK_LAYERS.forEach((layer) => {
      const r = chunkRaster(map, layer, i, j, JIRA);
      const at = chunkWorldRect(map, layer, i, j);
      expect(r.width).toBeLessThanOrEqual(512);
      expect(r.height).toBeLessThanOrEqual(512);
      expect([r.width, r.height]).toEqual([at.w, at.h]);
    }));
  });

  it('list a layer for a chunk exactly when that chunk has a visible pixel of it', () => {
    chunksOf(map).forEach(([i, j]) => {
      const listed = chunkLayers(map, i, j);
      CHUNK_LAYERS.forEach((layer) => expect([i, j, layer, listed.has(layer)]).toEqual([i, j, layer, opaque(chunkRaster(map, layer, i, j, JIRA))]));
    });
  });
});

describe('the classic four in chunks', () => {
  const map = buildOffice(CLASSIC_ROOMS);

  it('weigh no more than three full-size layer textures (16.83 MiB)', () => {
    const bytes = chunksOf(map).reduce((sum, [i, j]) => {
      const layers = chunkLayers(map, i, j);
      return sum + CHUNK_LAYERS.filter((l) => layers.has(l)).reduce((n, l) => {
        const at = chunkWorldRect(map, l, i, j);
        return n + at.w * at.h * 4;
      }, 0);
    }, 0);
    expect(bytes).toBeLessThanOrEqual(16.83 * MIB);
    expect(bytes).toBeLessThanOrEqual(17_637_376);
  });

  it('list every exterior chunk: none lies wholly inside the building', () => {
    expect(chunksOf(map).every(([i, j]) => chunkLayers(map, i, j).has('exterior'))).toBe(true);
  });
});

describe('chunkKey', () => {
  const map = buildOffice(CLASSIC_ROOMS);
  const keys = (m: OfficeMap, layer: ChunkLayer, options = JIRA): readonly string[] => chunksOf(m).map(([i, j]) => chunkKey(m, layer, i, j, options));

  it('is the same for the same map and options, and differs between chunks and layers', () => {
    expect(keys(map, 'map')).toEqual(keys(buildOffice(CLASSIC_ROOMS), 'map'));
    expect(new Set(CHUNK_LAYERS.flatMap((l) => keys(map, l))).size).toBe(3 * 12);
  });

  it('changes when a room is recoloured only for the map chunks that meet that room', () => {
    const recoloured = buildOffice(CLASSIC_ROOMS.map((r) => (r.id === 'local' ? { ...r, colour: '#3d7bff' } : r)));
    const before = keys(map, 'map');
    const after = keys(recoloured, 'map');
    const changed = chunksOf(map).filter((_, k) => before[k] !== after[k]).map(([i, j]) => `${i},${j}`);
    expect(changed).toEqual(['2,1', '3,1']);
    expect(keys(recoloured, 'daylight')).toEqual(keys(map, 'daylight'));
    expect(keys(recoloured, 'exterior')).toEqual(keys(map, 'exterior'));
    changed.forEach((k) => {
      const [i = 0, j = 0] = k.split(',').map(Number);
      expect(same(chunkRaster(recoloured, 'map', i, j), chunkRaster(map, 'map', i, j))).toBe(false);
    });
    chunksOf(map).filter(([i, j]) => !changed.includes(`${i},${j}`)).forEach(([i, j]) => {
      expect(same(chunkRaster(recoloured, 'map', i, j), chunkRaster(map, 'map', i, j))).toBe(true);
    });
  });

  it('changes for the map chunks of a room that hangs or takes down its Jira board', () => {
    const before = keys(map, 'map', { jiraRooms: [] });
    const after = keys(map, 'map', { jiraRooms: ['birch'] });
    expect(chunksOf(map).filter((_, k) => before[k] !== after[k]).map(([i, j]) => `${i},${j}`)).toEqual(['0,0', '1,0', '0,1', '1,1']);
  });
});

describe('downsample', () => {
  const four = paint(4, 4, (p) => {
    p.rect(0, 0, 2, 2, '#ff0000');
    p.rect(2, 0, 1, 1, '#0000ff');
  });

  it('averages each block over premultiplied alpha and rounds the size up', () => {
    const half = downsample(four, 2);
    expect([half.width, half.height]).toEqual([2, 2]);
    expect(pixelAt(half, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(half, 1, 0)).toEqual([0, 0, 255, 64]);
    expect(pixelAt(half, 0, 1)).toEqual([0, 0, 0, 0]);
    const odd = downsample(createRaster(5, 3), 4);
    expect([odd.width, odd.height]).toEqual([2, 1]);
  });

  it('keeps a stitched chunk grid stitchable at every factor', () => {
    const map = buildOffice(CLASSIC_ROOMS);
    ([2, 4, 8] as const).forEach((f) => {
      const whole = downsample(mapLayerRaster(map, JIRA), f);
      chunksOf(map).forEach(([i, j]) => {
        const part = downsample(chunkRaster(map, 'map', i, j, JIRA), f);
        const at = chunkPlacement(map, 'map', i, j);
        for (let y = 0; y < part.height; y += 7) for (let x = 0; x < part.width; x += 7) {
          expect(pixelAt(part, x, y)).toEqual(pixelAt(whole, at.x / f + x, at.y / f + y));
        }
      });
    });
  });

  it('refuses another factor', () => {
    expect(() => downsample(four, 3 as 2)).toThrow(RangeError);
  });
});
