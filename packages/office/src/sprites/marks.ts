import { paint, type Raster } from '../raster.js';

/** Map marks that show activity: the ring round a working character and the sparkle of an arrival. */

export const RING_SIZE = Object.freeze({ w: 28, h: 10 });
/** The ring is drawn in two halves: the back one behind the character, the front one over its desk or feet. */
export type RingHalf = 'back' | 'front';
/** Frames of the arrival sparkle, drawn in turn. */
export const SPARKLE_FRAMES = 4;
export const SPARKLE_SIZE = Object.freeze({ w: 15, h: 15 });

/**
 * One half of a soft ring lying round a character, white so the scene can tint it with the team colour: a two-pixel
 * ellipse edge with a fainter grey inside edge (a tint keeps grey dimmer). The other half is transparent, so both
 * halves share one size and centre.
 */
export function ringRaster(half: RingHalf): Raster {
  const { w, h } = RING_SIZE;
  const rx = (w - 1) / 2;
  const ry = (h - 1) / 2;
  return paint(w, h, (p) => {
    for (let y = 0; y < h; y += 1) {
      if ((half === 'back') !== (y < ry)) continue;
      for (let x = 0; x < w; x += 1) {
        const e = ((x - rx) / rx) ** 2 + ((y - ry) / ry) ** 2;
        if (e <= 1 && e > 0.55) p.put(x, y, '#ffffff');
        else if (e <= 0.55 && e > 0.36) p.put(x, y, '#7a7a7a');
      }
    }
  });
}

/** Points of the sparkle per frame: [dx, dy, size] from the centre; size 1 is a dot, 2 and 3 are small crosses. */
const SPARKS: readonly (readonly (readonly [number, number, number])[])[] = Object.freeze([
  [[0, 0, 2], [-4, -3, 1], [4, 3, 1]],
  [[0, 0, 3], [-5, 2, 1], [4, -4, 2], [3, 5, 1]],
  [[-4, -2, 2], [4, 3, 2], [0, -6, 1], [-2, 5, 1], [6, -1, 1]],
  [[-6, -4, 1], [6, 5, 1], [-3, 6, 1], [5, -5, 1]],
]);

/** One frame (0..SPARKLE_FRAMES - 1, wrapping) of the short sparkle round a session Luady just started. */
export function sparkleRaster(frame: number): Raster {
  const f = ((Math.floor(Number.isFinite(frame) ? frame : 0) % SPARKLE_FRAMES) + SPARKLE_FRAMES) % SPARKLE_FRAMES;
  const c = Math.floor(SPARKLE_SIZE.w / 2);
  return paint(SPARKLE_SIZE.w, SPARKLE_SIZE.h, (p) => {
    (SPARKS[f] ?? []).forEach(([dx, dy, size]) => {
      const x = c + dx;
      const y = c + dy;
      p.put(x, y, '#fff6c8');
      if (size < 2) return;
      p.put(x - 1, y, '#ffd84d'); p.put(x + 1, y, '#ffd84d'); p.put(x, y - 1, '#ffd84d'); p.put(x, y + 1, '#ffd84d');
      if (size < 3) return;
      p.put(x - 2, y, '#3cc3b0'); p.put(x + 2, y, '#3cc3b0'); p.put(x, y - 2, '#3cc3b0'); p.put(x, y + 2, '#3cc3b0');
    });
  });
}
