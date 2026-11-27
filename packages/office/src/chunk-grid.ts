import { EXTERIOR_MARGIN } from './sprites/exterior.js';
import type { PixelPoint } from './types.js';

/** Edge of one chunk in world pixels. */
export const CHUNK_PX = 512;

/**
 * The one chunk grid every layer shares. Its origin is the exterior's top-left corner, (-320, -320) in map pixels, and
 * it covers the exterior's extent: chunk (i, j) is world `[x0 + 512 i, x0 + 512 (i + 1)) × [y0 + 512 j, y0 + 512 (j + 1))`.
 */
export interface ChunkGrid {
  /** Top-left of chunk (0, 0), in map pixels. */
  readonly origin: PixelPoint;
  readonly size: number;
  /** Chunk columns (i runs 0..cols-1, along x) and rows (j runs 0..rows-1, along y). */
  readonly cols: number;
  readonly rows: number;
}

/** The chunk grid of a map `width × height` pixels. */
export function chunkGridFor(width: number, height: number): ChunkGrid {
  return Object.freeze({
    origin: Object.freeze({ x: -EXTERIOR_MARGIN, y: -EXTERIOR_MARGIN }),
    size: CHUNK_PX,
    cols: Math.ceil((width + EXTERIOR_MARGIN * 2) / CHUNK_PX),
    rows: Math.ceil((height + EXTERIOR_MARGIN * 2) / CHUNK_PX),
  });
}
