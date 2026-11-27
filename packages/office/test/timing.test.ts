import { describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { slotsFor } from '../src/desks.js';
import { CHUNK_LAYERS, chunkRaster, chunkWorldRect, type ChunkLayer } from '../src/chunks.js';
import { buildOffice } from '../src/layout.js';
import { findPath } from '../src/path.js';
import { propsFor } from '../src/props.js';
import { rasterHighWater, resetRasterHighWater } from '../src/raster.js';
import { isFurnished } from '../src/rooms.js';
import { EXTERIOR_MARGIN, treeKeepClear } from '../src/sprites/exterior.js';
import { treeSpots } from '../src/sprites/groves.js';
import { walkMask } from '../src/walk.js';
import { rooms } from './rooms-fixture.js';
import { seeded } from './seeded.js';

/**
 * The timing line: printed for information, never asserted. Every cost is measured at 300
 * rooms. Nothing here waits on the clock; the one assertion is about raster sizes, not time.
 */

const median = (xs: readonly number[]): number => {
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};
const ms = (n: number): string => `${n.toFixed(2)} ms`;
const time = (run: () => void): number => {
  const t0 = performance.now();
  run();
  return performance.now() - t0;
};

describe('timing at 300 rooms (printed, not asserted)', () => {
  it('prints buildOffice, walkMask, the median A* walk, the mean chunkRaster per layer and treeSpots', () => {
    const input = rooms(300);
    const build = median(Array.from({ length: 5 }, (_, k) => time(() => buildOffice(input.map((r) => ({ ...r, accent: `#00000${k}` }))))));
    const map = buildOffice(input);
    const furnished = map.order.filter((key) => isFurnished(map.rooms[key]!));
    const slots = Object.fromEntries(furnished.map((key) => [key, slotsFor(map.rooms[key]!, 'normal')]));
    const props = propsFor(map, {});
    const cold = time(() => walkMask(buildOffice(rooms(299)), slots, props));
    const warm = median(Array.from({ length: 5 }, () => time(() => walkMask(map, slots, props))));
    const mask = walkMask(map, slots, props);
    const seats = Object.values(slots).flat().map((s) => s.tile);
    const random = seeded(7);
    const walks = Array.from({ length: 60 }, () => {
      const from = seats[Math.floor(random() * seats.length)]!;
      const to = seats[Math.floor(random() * seats.length)]!;
      return time(() => findPath(mask, from, to));
    });
    resetRasterHighWater();
    const perLayer = (layer: ChunkLayer): number => {
      const times: number[] = [];
      for (let j = 0; j < map.chunks.rows; j += 1) {
        for (let i = 0; i < map.chunks.cols; i += 1) {
          if (chunkWorldRect(map, layer, i, j).w > 0) times.push(time(() => chunkRaster(map, layer, i, j)));
        }
      }
      return times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
    };
    const chunks = CHUNK_LAYERS.map((layer) => `${layer} ${ms(perLayer(layer))}`).join(', ');
    expect(rasterHighWater()).toBeLessThanOrEqual(512);
    const trees = time(() => treeSpots(map.width + EXTERIOR_MARGIN * 2, map.height + EXTERIOR_MARGIN * 2, treeKeepClear(map)));
    console.log([
      `timing at 300 rooms (${map.width} x ${map.height} px, ${map.chunks.cols} x ${map.chunks.rows} chunks):`,
      `buildOffice ${ms(build)}`, `walkMask ${ms(cold)} cold, ${ms(warm)} warm`, `A* median ${ms(median(walks))}`,
      `chunkRaster mean ${chunks}`, `treeSpots ${ms(trees)}`,
    ].join(' | '));
  });
});
