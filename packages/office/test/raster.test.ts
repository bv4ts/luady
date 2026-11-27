import { describe, expect, it } from 'vitest';
import {
  blit, createRaster, cropRaster, fillRect, paint, paintWindow, pixelAt, rasterHighWater, resetRasterHighWater, type Painter,
} from '../src/raster.js';

const RED = [255, 0, 0, 255] as const;
const CLEAR = [0, 0, 0, 0] as const;

describe('createRaster', () => {
  it('is transparent', () => {
    const r = createRaster(2, 2);
    expect(r.width).toBe(2);
    expect(r.height).toBe(2);
    expect(Array.from(r.data)).toEqual(new Array(16).fill(0));
    expect(Object.isFrozen(r)).toBe(true);
  });

  it('allows an empty raster and rejects a bad size', () => {
    expect(createRaster(0, 0).data.length).toBe(0);
    expect(() => createRaster(-1, 2)).toThrow(RangeError);
    expect(() => createRaster(1.5, 2)).toThrow(RangeError);
  });
});

describe('fillRect', () => {
  it('returns a new raster and leaves its input alone', () => {
    const before = createRaster(3, 3);
    const after = fillRect(before, 1, 1, 1, 1, '#ff0000');
    expect(after).not.toBe(before);
    expect(after.data).not.toBe(before.data);
    expect(Array.from(before.data).every((v) => v === 0)).toBe(true);
    expect(pixelAt(after, 1, 1)).toEqual(RED);
    expect(pixelAt(after, 0, 0)).toEqual(CLEAR);
  });

  it('clips a rectangle that hangs off the edge', () => {
    const r = fillRect(createRaster(4, 4), 2, -1, 5, 2, '#0000ff');
    expect(pixelAt(r, 2, 0)).toEqual([0, 0, 255, 255]);
    expect(pixelAt(r, 3, 0)).toEqual([0, 0, 255, 255]);
    expect(pixelAt(r, 1, 0)).toEqual(CLEAR);
    expect(pixelAt(r, 2, 1)).toEqual(CLEAR);
  });

  it('draws nothing for an empty or fully outside rectangle', () => {
    const r = createRaster(2, 2);
    expect(Array.from(fillRect(r, 0, 0, 0, 2, '#ffffff').data)).toEqual(Array.from(r.data));
    expect(Array.from(fillRect(r, 5, 5, 2, 2, '#ffffff').data)).toEqual(Array.from(r.data));
  });
});

describe('blit', () => {
  it('copies opaque pixels, skips transparent ones and leaves both inputs alone', () => {
    const dst = fillRect(createRaster(3, 1), 0, 0, 3, 1, '#00ff00');
    const src = fillRect(createRaster(2, 1), 0, 0, 1, 1, '#ff0000');
    const out = blit(dst, src, 1, 0);
    expect(pixelAt(out, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(out, 1, 0)).toEqual(RED);
    expect(pixelAt(out, 2, 0)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(dst, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(src, 1, 0)).toEqual(CLEAR);
  });

  it('clips at every edge', () => {
    const src = fillRect(createRaster(2, 2), 0, 0, 2, 2, '#ff0000');
    const out = blit(createRaster(2, 2), src, -1, 1);
    expect(pixelAt(out, 0, 1)).toEqual(RED);
    expect(pixelAt(out, 0, 0)).toEqual(CLEAR);
    expect(pixelAt(out, 1, 1)).toEqual(CLEAR);
    expect(Array.from(blit(createRaster(2, 2), src, 9, 9).data).every((v) => v === 0)).toBe(true);
  });
});

describe('pixelAt', () => {
  it('reads transparent outside the raster', () => {
    const r = fillRect(createRaster(1, 1), 0, 0, 1, 1, '#ffffff');
    expect(pixelAt(r, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(r, -1, 0)).toEqual(CLEAR);
    expect(pixelAt(r, 0, 1)).toEqual(CLEAR);
    expect(pixelAt(r, 0.5, 0)).toEqual(CLEAR);
  });
});

describe('paint', () => {
  it('draws rects and single pixels into one new raster', () => {
    const r = paint(4, 2, (p) => {
      p.rect(0, 0, 4, 2, '#102030');
      p.rect(3, 1, 9, 9, '#ff0000');
      p.put(1, 0, '#ffffff');
      p.put(-1, 0, '#ffffff');
    });
    expect(pixelAt(r, 0, 0)).toEqual([16, 32, 48, 255]);
    expect(pixelAt(r, 1, 0)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(r, 3, 1)).toEqual(RED);
  });

  it('stops a painter that escapes its callback', () => {
    let kept: Painter | null = null;
    const r = paint(1, 1, (p) => {
      kept = p;
    });
    expect(() => kept?.put(0, 0, '#ffffff')).toThrow();
    expect(() => kept?.rect(0, 0, 1, 1, '#ffffff')).toThrow();
    expect(pixelAt(r, 0, 0)).toEqual(CLEAR);
  });

  it('rejects a colour that is not #rrggbb', () => {
    expect(() => paint(1, 1, (p) => p.put(0, 0, 'red'))).toThrow(RangeError);
  });
});

describe('paintWindow', () => {
  const draw = (p: Painter): void => {
    p.rect(-3, -2, 9, 4, '#ff0000');
    p.rect(2.4, 3.6, 5.2, 2.5, '#00ff00');
    p.put(7, 1, '#0000ff');
    p.rect(-50, 40, 10, 10, '#ffffff');
  };

  it('paints world coordinates into its window, clipped: the same pixels as cropping the whole picture', () => {
    const whole = paintWindow({ x: -8, y: -8, w: 24, h: 24 }, draw);
    [{ x: 0, y: 0, w: 12, h: 10 }, { x: 2, y: 1, w: 5, h: 6 }, { x: 7, y: 0, w: 5, h: 2 }, { x: -4, y: -4, w: 6, h: 6 }].forEach((win) => {
      const part = paintWindow(win, draw);
      expect([part.width, part.height]).toEqual([win.w, win.h]);
      expect(Array.from(part.data)).toEqual(Array.from(cropRaster(whole, win.x + 8, win.y + 8, win.w, win.h).data));
    });
    expect(pixelAt(paintWindow({ x: -4, y: -4, w: 6, h: 6 }, draw), 1, 2)).toEqual(RED);
  });

  it('is what paint is, from the origin', () => {
    expect(Array.from(paintWindow({ x: 0, y: 0, w: 12, h: 10 }, draw).data)).toEqual(Array.from(paint(12, 10, draw).data));
  });

  it('rejects a window that is not whole', () => {
    expect(() => paintWindow({ x: 0.5, y: 0, w: 2, h: 2 }, draw)).toThrow(RangeError);
    expect(() => paintWindow({ x: 0, y: 0, w: -1, h: 2 }, draw)).toThrow(RangeError);
  });

  it('keeps a high-water mark of the largest raster made', () => {
    resetRasterHighWater();
    paintWindow({ x: 100, y: 100, w: 30, h: 70 }, draw);
    createRaster(5, 40);
    expect(rasterHighWater()).toBe(70);
  });
});
