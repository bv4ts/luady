import { createRaster, type Raster } from '../raster.js';

/** The warm light of the lamps, and how strongly each ring of a pool takes it (centre last). */
const LIGHT = [0xff, 0xd9, 0x8a] as const;
const STRENGTH = [0, 0.08, 0.14, 0.21] as const;
/** Half-axes of the pool of light under a lamp, in pixels. */
export const POOL = Object.freeze({ rx: 26, ry: 12 });

interface Area { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/** 0 outside the pool, 1–3 from the rim towards the foot; the outer ring is dithered so the edge stays soft. */
const ringAt = (dx: number, dy: number, x: number, y: number): number => {
  const e = (dx * dx) / (POOL.rx * POOL.rx) + (dy * dy) / (POOL.ry * POOL.ry);
  if (e > 1) return 0;
  if (e < 0.22) return 3;
  if (e < 0.55) return 2;
  return (x + y) % 2 === 0 ? 1 : 0;
};

interface Origin { readonly x: number; readonly y: number }

/** The strongest ring of any pool at each pixel of a `w × h` picture whose corner sits at `origin` (one byte per pixel). */
const ringMap = (w: number, h: number, feet: readonly (readonly [number, number])[], skip: Area, origin: Origin): Uint8Array => {
  const rings = new Uint8Array(w * h);
  feet.forEach(([fx, fy]) => {
    const cy = fy + 2;
    for (let y = Math.max(origin.y, cy - POOL.ry); y <= Math.min(origin.y + h - 1, cy + POOL.ry); y += 1) {
      for (let x = Math.max(origin.x, fx - POOL.rx); x <= Math.min(origin.x + w - 1, fx + POOL.rx); x += 1) {
        if (x >= skip.x && x < skip.x + skip.w && y >= skip.y && y < skip.y + skip.h) continue;
        const ring = ringAt(x - fx, y - cy, x, y);
        const i = (y - origin.y) * w + (x - origin.x);
        if (ring > (rings[i] ?? 0)) rings[i] = ring;
      }
    }
  });
  return rings;
};

/** The pixels a lamp's pool of light can touch: its foot's ellipse, `2 rx + 1` by `2 ry + 1`. */
export function poolBox(fx: number, fy: number): Area {
  return { x: fx - POOL.rx, y: fy + 2 - POOL.ry, w: POOL.rx * 2 + 1, h: POOL.ry * 2 + 1 };
}

/**
 * A copy of the garden picture with a pool of warm light on the ground under each lamp foot. Where the picture is
 * transparent the grass shows through, so the pool lights the grass tile itself (`ground`, which the scene lays on a
 * grid that the picture's corner sits on). Pixels inside `skip` (the building) are left untouched. `picture` may be a
 * frame of the garden whose corner sits at `origin`: feet, `skip` and the grass are then read in the garden's own
 * coordinates, so the frame gets exactly the pixels it has in the whole picture.
 */
export function withLampLight(picture: Raster, ground: Raster, feet: readonly (readonly [number, number])[], skip: Area, origin: Origin = { x: 0, y: 0 }): Raster {
  const { width: w, height: h } = picture;
  const out = createRaster(w, h);
  out.data.set(picture.data);
  const rings = ringMap(w, h, feet, skip, origin);
  for (let i = 0; i < rings.length; i += 1) {
    const ring = rings[i] ?? 0;
    if (ring === 0) continue;
    const x = origin.x + (i % w);
    const y = origin.y + Math.floor(i / w);
    const p = i * 4;
    const src = (picture.data[p + 3] ?? 0) === 0 ? ground.data : picture.data;
    const s = src === ground.data ? ((y % ground.height) * ground.width + (x % ground.width)) * 4 : p;
    const k = STRENGTH[ring] ?? 0;
    LIGHT.forEach((light, c) => { out.data[p + c] = Math.round((src[s + c] ?? 0) + (light - (src[s + c] ?? 0)) * k); });
    out.data[p + 3] = 255;
  }
  return out;
}
