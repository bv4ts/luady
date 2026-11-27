import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/** A decoded picture: RGBA, row-major, 4 bytes per pixel. */
export interface Picture { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray }

const SIGNATURE = '89504e470d0a1a0a';

/** The Paeth predictor of the PNG filters. */
const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Undoes one scanline's filter in place, given the previous (already unfiltered) line. */
const unfilter = (filter: number, line: Uint8Array, prev: Uint8Array, bpp: number): void => {
  for (let x = 0; x < line.length; x += 1) {
    const left = x >= bpp ? (line[x - bpp] ?? 0) : 0;
    const up = prev[x] ?? 0;
    const upLeft = x >= bpp ? (prev[x - bpp] ?? 0) : 0;
    const v = line[x] ?? 0;
    if (filter === 1) line[x] = (v + left) & 0xff;
    else if (filter === 2) line[x] = (v + up) & 0xff;
    else if (filter === 3) line[x] = (v + ((left + up) >> 1)) & 0xff;
    else if (filter === 4) line[x] = (v + paeth(left, up, upLeft)) & 0xff;
    else if (filter !== 0) throw new Error(`png: unknown filter ${filter}`);
  }
};

/**
 * Decodes an 8-bit RGBA, non-interlaced PNG (the shipped atlas format) with node:zlib: a test helper, so the
 * golden test reads the shipped atlas without a canvas or a dependency.
 */
export function decodePng(path: string): Picture {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 8).toString('hex') !== SIGNATURE) throw new Error(`png: ${path} is not a PNG`);
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('ascii', at + 4, at + 8);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error('png: only 8-bit RGBA without interlace is supported');
    } else if (type === 'IDAT') {
      idat.push(body);
    }
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const data = new Uint8ClampedArray(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const line = Uint8Array.from(raw.subarray(start + 1, start + 1 + stride));
    unfilter(raw[start] ?? 0, line, prev, 4);
    data.set(line, y * stride);
    prev = line;
  }
  return { width, height, data };
}

/** The `w × h` cell of a picture whose top-left is (x, y), as its own RGBA array. */
export function cellOf(picture: Picture, x: number, y: number, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row += 1) {
    const from = ((y + row) * picture.width + x) * 4;
    out.set(picture.data.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}
