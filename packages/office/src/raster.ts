import { hexToRgb } from './colors.js';
import type { PixelRect } from './types.js';

/**
 * An RGBA picture, row-major, 4 bytes per pixel. Treat `data` as read-only: every function here returns a new raster
 * and never writes into one it was given (a typed array cannot be frozen, so this is a promise, not a lock).
 */
export interface Raster { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray }

/** Draws into the private buffer of one `paint` call. Colours are '#rrggbb', always opaque. */
export interface Painter {
  rect(x: number, y: number, w: number, h: number, color: string): void;
  put(x: number, y: number, color: string): void;
}

type Rgb = readonly [number, number, number];

const checkSize = (width: number, height: number): void => {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 0 || height < 0) {
    throw new RangeError(`raster size must be whole and non-negative, got ${width} x ${height}`);
  }
};

const wrap = (width: number, height: number, data: Uint8ClampedArray): Raster => Object.freeze({ width, height, data });

/** The longest side of any raster made since the last reset: the tests' proof that no map-sized raster was built. */
let highWater = 0;
const allocate = (width: number, height: number): Uint8ClampedArray => {
  highWater = Math.max(highWater, width, height);
  return new Uint8ClampedArray(width * height * 4);
};

/** The longest side of every raster made since resetRasterHighWater (chunks are at most 512 px). */
export function rasterHighWater(): number {
  return highWater;
}

export function resetRasterHighWater(): void {
  highWater = 0;
}

/** A fully transparent raster. */
export function createRaster(width: number, height: number): Raster {
  checkSize(width, height);
  return wrap(width, height, allocate(width, height));
}

/** Fills a clipped rectangle of a buffer this module owns. */
const fillInto = (data: Uint8ClampedArray, width: number, height: number, box: readonly [number, number, number, number], rgb: Rgb): void => {
  const [x, y, w, h] = box;
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(width, Math.round(x + w));
  const y1 = Math.min(height, Math.round(y + h));
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const i = (py * width + px) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
    }
  }
};

/** A copy of the raster with one opaque rectangle filled in, clipped to the raster. */
export function fillRect(r: Raster, x: number, y: number, w: number, h: number, color: string): Raster {
  const data = new Uint8ClampedArray(r.data);
  fillInto(data, r.width, r.height, [x, y, w, h], hexToRgb(color));
  return wrap(r.width, r.height, data);
}

/** A copy of dst with src drawn at (dx, dy). Fully transparent source pixels are skipped; the rest replace what is below. */
export function blit(dst: Raster, src: Raster, dx: number, dy: number): Raster {
  const data = new Uint8ClampedArray(dst.data);
  const ox = Math.round(dx);
  const oy = Math.round(dy);
  for (let sy = Math.max(0, -oy); sy < src.height && sy + oy < dst.height; sy += 1) {
    for (let sx = Math.max(0, -ox); sx < src.width && sx + ox < dst.width; sx += 1) {
      const s = (sy * src.width + sx) * 4;
      if (src.data[s + 3] === 0) continue;
      data.set(src.data.subarray(s, s + 4), ((sy + oy) * dst.width + sx + ox) * 4);
    }
  }
  return wrap(dst.width, dst.height, data);
}

/** [r, g, b, a] at a pixel; transparent black outside the raster. */
export function pixelAt(r: Raster, x: number, y: number): readonly [number, number, number, number] {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= r.width || y >= r.height) return Object.freeze([0, 0, 0, 0] as const);
  const i = (y * r.width + x) * 4;
  return Object.freeze([r.data[i] ?? 0, r.data[i + 1] ?? 0, r.data[i + 2] ?? 0, r.data[i + 3] ?? 0] as const);
}

/** A copy of the `w × h` frame of `r` whose top-left is (x, y); pixels outside `r` are transparent. */
export function cropRaster(r: Raster, x: number, y: number, w: number, h: number): Raster {
  const out = createRaster(w, h);
  const x0 = Math.max(0, x);
  const x1 = Math.min(r.width, x + w);
  for (let row = Math.max(0, y); row < Math.min(r.height, y + h) && x1 > x0; row += 1) {
    out.data.set(r.data.subarray((row * r.width + x0) * 4, (row * r.width + x1) * 4), ((row - y) * w + (x0 - x)) * 4);
  }
  return out;
}

/**
 * The raster shrunk by `factor` (2, 4 or 8): each output pixel is the box average of its `factor × factor` block,
 * taken over premultiplied alpha so transparent pixels add no colour. The size is rounded up; a block that runs past
 * the edge counts the missing pixels as transparent.
 */
export function downsample(r: Raster, factor: 2 | 4 | 8): Raster {
  if (factor !== 2 && factor !== 4 && factor !== 8) throw new RangeError(`downsample factor must be 2, 4 or 8, got ${String(factor)}`);
  const out = createRaster(Math.ceil(r.width / factor), Math.ceil(r.height / factor));
  const area = factor * factor;
  const sum = [0, 0, 0, 0];
  for (let oy = 0; oy < out.height; oy += 1) {
    for (let ox = 0; ox < out.width; ox += 1) {
      blockSum(r, ox * factor, oy * factor, factor, sum);
      const [red = 0, green = 0, blue = 0, alpha = 0] = sum;
      if (alpha === 0) continue;
      out.data.set([Math.round(red / alpha), Math.round(green / alpha), Math.round(blue / alpha), Math.round(alpha / area)], (oy * out.width + ox) * 4);
    }
  }
  return out;
}

/** Premultiplied sums [r·a, g·a, b·a, a] of the `size × size` block at (x0, y0), written into `into`. */
const blockSum = (r: Raster, x0: number, y0: number, size: number, into: number[]): void => {
  into.fill(0);
  for (let y = y0; y < Math.min(r.height, y0 + size); y += 1) {
    for (let x = x0; x < Math.min(r.width, x0 + size); x += 1) {
      const i = (y * r.width + x) * 4;
      const a = r.data[i + 3] ?? 0;
      into[0] = (into[0] ?? 0) + (r.data[i] ?? 0) * a;
      into[1] = (into[1] ?? 0) + (r.data[i + 1] ?? 0) * a;
      into[2] = (into[2] ?? 0) + (r.data[i + 2] ?? 0) * a;
      into[3] = (into[3] ?? 0) + a;
    }
  }
};

/**
 * Draws many rectangles into one fresh buffer covering `win` and returns it as a raster. The painter
 * takes world coordinates: the frame translates and clips them, so painting a frame gives exactly the pixels of
 * the same frame cut out of the whole picture (rectangles only overwrite). The painter works only while `draw` runs;
 * calling it afterwards throws, so the returned raster can never change.
 */
export function paintWindow(win: PixelRect, draw: (p: Painter) => void): Raster {
  if (!Number.isInteger(win.x) || !Number.isInteger(win.y)) throw new RangeError(`a frame starts on a whole pixel, got ${win.x}, ${win.y}`);
  checkSize(win.w, win.h);
  const { x: ox, y: oy, w: width, h: height } = win;
  const data = allocate(width, height);
  const colours = new Map<string, Rgb>();
  let open = true;
  const rgbOf = (color: string): Rgb => {
    if (!open) throw new Error('painter used after paint() returned');
    const known = colours.get(color);
    if (known !== undefined) return known;
    const rgb = hexToRgb(color);
    colours.set(color, rgb);
    return rgb;
  };
  const painter: Painter = Object.freeze({
    rect: (x: number, y: number, w: number, h: number, color: string): void => fillInto(data, width, height, [x - ox, y - oy, w, h], rgbOf(color)),
    put: (x: number, y: number, color: string): void => fillInto(data, width, height, [x - ox, y - oy, 1, 1], rgbOf(color)),
  });
  try {
    draw(painter);
  } finally {
    open = false;
  }
  return wrap(width, height, data);
}

/** paintWindow over `[0, width) × [0, height)`. */
export function paint(width: number, height: number, draw: (p: Painter) => void): Raster {
  return paintWindow({ x: 0, y: 0, w: width, h: height }, draw);
}
