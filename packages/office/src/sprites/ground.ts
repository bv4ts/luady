import { paint, type Painter, type Raster } from '../raster.js';

/** Edge of the repeating grass tile, in pixels. */
export const GROUND_TILE = 64;

/** Dusk grass: dark, calm greens that sit beside the slate office floors. */
export const GRASS = Object.freeze({
  base: '#17231e',
  dark: '#131d19',
  deep: '#101814',
  light: '#1c2a23',
  blade: '#223229',
  tip: '#283b30',
  bloom: '#4f5a6e',
});

/** A small integer hash (no random calls: the same tile every time, on every device). */
export function hash2(x: number, y: number, salt = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(salt | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

const wrap = (n: number): number => ((n % GROUND_TILE) + GROUND_TILE) % GROUND_TILE;
/** Puts a pixel on the tile with wrap-around, so a shape that crosses an edge continues on the opposite one. */
const putWrapped = (p: Painter, x: number, y: number, colour: string): void => p.put(wrap(x), wrap(y), colour);

/** One blade tuft: a short stem with a lit tip, leaning by `lean`. */
const tuft = (p: Painter, x: number, y: number, lean: number): void => {
  putWrapped(p, x, y, GRASS.blade);
  putWrapped(p, x + lean, y - 1, GRASS.blade);
  putWrapped(p, x + lean, y - 2, GRASS.tip);
  putWrapped(p, x - 1, y, GRASS.blade);
  putWrapped(p, x - 2, y - 1, GRASS.tip);
  putWrapped(p, x, y + 1, GRASS.deep);
};

const TUFTS = 34;
const BLOOMS = 3;

/**
 * The grass that covers everything around the building: 64 × 64, opaque, and seamless (every speck and tuft wraps
 * across the edges, so laid side by side the tiles show no line).
 */
export function groundRaster(): Raster {
  return paint(GROUND_TILE, GROUND_TILE, (p) => {
    p.rect(0, 0, GROUND_TILE, GROUND_TILE, GRASS.base);
    for (let y = 0; y < GROUND_TILE; y += 1) {
      for (let x = 0; x < GROUND_TILE; x += 1) {
        const h = hash2(x, y, 1) % 23;
        if (h === 0) p.put(x, y, GRASS.dark);
        else if (h === 1) p.put(x, y, GRASS.light);
        else if (h === 2 && (x + y) % 2 === 0) p.put(x, y, GRASS.deep);
      }
    }
    for (let i = 0; i < TUFTS; i += 1) {
      tuft(p, hash2(i, 0, 2) % GROUND_TILE, hash2(i, 1, 2) % GROUND_TILE, hash2(i, 2, 2) % 2 === 0 ? 1 : -1);
    }
    for (let i = 0; i < BLOOMS; i += 1) {
      const x = hash2(i, 0, 3) % GROUND_TILE;
      const y = hash2(i, 1, 3) % GROUND_TILE;
      putWrapped(p, x, y, GRASS.bloom);
      putWrapped(p, x, y + 1, GRASS.blade);
    }
  });
}
