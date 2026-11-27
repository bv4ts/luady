import { describe, expect, it } from 'vitest';
import { pixelAt, type Raster } from '../src/raster.js';
import { RING_SIZE, SPARKLE_FRAMES, SPARKLE_SIZE, ringRaster, sparkleRaster } from '../src/sprites/marks.js';

const opaque = (r: Raster): number => {
  let n = 0;
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] === 255) n += 1;
  return n;
};

describe('ringRaster', () => {
  const back = ringRaster('back');
  const front = ringRaster('front');

  it('is a hollow ellipse in two halves of one size, white at its edge so a tint gives it the team colour', () => {
    [back, front].forEach((half) => {
      expect([half.width, half.height]).toEqual([RING_SIZE.w, RING_SIZE.h]);
      expect(pixelAt(half, 14, 5)[3]).toBe(0);
      expect(opaque(half)).toBeGreaterThan(20);
    });
    expect(pixelAt(back, 1, 4)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(front, 1, 4)[3]).toBe(0);
    expect(pixelAt(front, 14, 8)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(back, 14, 8)[3]).toBe(0);
    expect(pixelAt(back, 14, 1)).toEqual([255, 255, 255, 255]);
  });

  it('splits the ring cleanly: no pixel is in both halves', () => {
    for (let i = 3; i < back.data.length; i += 4) expect((back.data[i] ?? 0) > 0 && (front.data[i] ?? 0) > 0).toBe(false);
  });
});

describe('sparkleRaster', () => {
  it('has four different frames of the same size, and wraps', () => {
    const frames = Array.from({ length: SPARKLE_FRAMES }, (_, i) => sparkleRaster(i));
    frames.forEach((f) => {
      expect([f.width, f.height]).toEqual([SPARKLE_SIZE.w, SPARKLE_SIZE.h]);
      expect(opaque(f)).toBeGreaterThan(2);
    });
    expect(new Set(frames.map((f) => Array.from(f.data).join())).size).toBe(4);
    expect(sparkleRaster(5).data).toEqual(sparkleRaster(1).data);
    expect(sparkleRaster(Number.NaN).data).toEqual(sparkleRaster(0).data);
  });
});
