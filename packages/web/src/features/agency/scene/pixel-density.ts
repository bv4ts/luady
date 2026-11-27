import type { ViewSize } from './camera-math.js';

/** The largest canvas backing store the scene draws into, in pixels; above it the browser's scaling is used. */
export const CANVAS_PIXEL_CAP = 8_000_000;

/**
 * How the canvas is drawn for one zoom: `resolution` canvas pixels per CSS pixel, and whether the browser scales the
 * canvas down smoothly (`smooth`, CSS image-rendering auto) or shows it pixel for pixel (pixelated).
 */
export interface DensityChoice { readonly resolution: number; readonly smooth: boolean }

const EPSILON = 1e-6;

/**
 * Crisp pixels at any zoom. With `n = ceil(zoom × devicePixelRatio)` and `resolution = n / zoom`, every map
 * pixel covers exactly `n` canvas pixels, and the browser scales the canvas down to the screen smoothly. When the
 * zoom already gives whole device pixels the device ratio is used as is. When the canvas would pass `cap` pixels, the
 * device ratio is used and pixels are shown nearest-neighbour at the fractional zoom.
 */
export function crispResolution(zoom: number, deviceRatio: number, view: ViewSize, cap = CANVAS_PIXEL_CAP): DensityChoice {
  const ratio = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  if (!Number.isFinite(zoom) || zoom <= 0) return Object.freeze({ resolution: ratio, smooth: false });
  const devicePixels = zoom * ratio;
  if (Math.abs(devicePixels - Math.round(devicePixels)) < EPSILON && Math.round(devicePixels) >= 1) {
    return Object.freeze({ resolution: ratio, smooth: false });
  }
  const n = Math.max(1, Math.ceil(devicePixels - EPSILON));
  const resolution = n / zoom;
  const pixels = Math.ceil(view.width * resolution) * Math.ceil(view.height * resolution);
  if (pixels > cap) return Object.freeze({ resolution: ratio, smooth: false });
  return Object.freeze({ resolution, smooth: true });
}
