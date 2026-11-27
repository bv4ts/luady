import { describe, expect, it } from 'vitest';
import { wholeOfficeFit } from '../../../../src/features/agency/scene/camera-math.js';
import { CANVAS_PIXEL_CAP, crispResolution } from '../../../../src/features/agency/scene/pixel-density.js';
import { snap } from './office-fixtures.js';

const BARS = { top: 56, right: 0, bottom: 64, left: 0 };
const map = snap([]).map;
/** Canvas pixels per map pixel for a choice at this zoom. */
const perMapPixel = (zoom: number, resolution: number): number => zoom * resolution;
const isWhole = (n: number): boolean => Math.abs(n - Math.round(n)) < 1e-9;

describe('crispResolution', () => {
  it('draws whole canvas pixels per map pixel and lets the browser scale down smoothly at a fractional zoom', () => {
    const choice = crispResolution(1.4634, 1, { width: 1920, height: 1080 });
    expect(choice.smooth).toBe(true);
    expect(perMapPixel(1.4634, choice.resolution)).toBeCloseTo(2, 9);
  });

  it.each([
    ['1920×1080 at 1x', { width: 1920, height: 1080 }, 1, 2],
    ['1366×768 at 1x', { width: 1366, height: 768 }, 1, 2],
    ['390×844 at 3x', { width: 390, height: 844 }, 3, 3],
  ] as const)('gives the opening view of %s whole, even pixels', (_name, view, ratio, n) => {
    const zoom = wholeOfficeFit(map, view, BARS).scale;
    const choice = crispResolution(zoom, ratio, view);
    expect(choice.smooth).toBe(true);
    expect(isWhole(perMapPixel(zoom, choice.resolution))).toBe(true);
    expect(Math.round(perMapPixel(zoom, choice.resolution))).toBe(n);
    expect(choice.resolution).toBeGreaterThanOrEqual(ratio);
    expect(Math.ceil(view.width * choice.resolution) * Math.ceil(view.height * choice.resolution)).toBeLessThanOrEqual(CANVAS_PIXEL_CAP);
  });

  it('falls back to the device ratio, pixel for pixel, when the canvas would pass 8 megapixels (1512×982 at 2x)', () => {
    expect(CANVAS_PIXEL_CAP).toBe(8_000_000);
    const view = { width: 1512, height: 982 };
    const zoom = wholeOfficeFit(map, view, BARS).scale;
    expect(Math.ceil(zoom * 2) / zoom * 1512 * (Math.ceil(zoom * 2) / zoom) * 982).toBeGreaterThan(CANVAS_PIXEL_CAP);
    expect(crispResolution(zoom, 2, view)).toEqual({ resolution: 2, smooth: false });
  });

  it('keeps the device ratio when the zoom already gives whole device pixels', () => {
    expect(crispResolution(2, 1, { width: 800, height: 600 })).toEqual({ resolution: 1, smooth: false });
    expect(crispResolution(1.5, 2, { width: 800, height: 600 })).toEqual({ resolution: 2, smooth: false });
  });

  it('draws one canvas pixel per map pixel below one device pixel', () => {
    const choice = crispResolution(0.3, 2, { width: 390, height: 844 });
    expect(perMapPixel(0.3, choice.resolution)).toBeCloseTo(1, 9);
    expect(choice.smooth).toBe(true);
  });

  it('honours a smaller cap', () => {
    expect(crispResolution(1.4634, 1, { width: 1920, height: 1080 }, 1_000_000)).toEqual({ resolution: 1, smooth: false });
  });

  it('treats a nonsense zoom or ratio safely', () => {
    expect(crispResolution(Number.NaN, 2, { width: 10, height: 10 })).toEqual({ resolution: 2, smooth: false });
    expect(crispResolution(1.5, 0, { width: 10, height: 10 }).resolution).toBeCloseTo(4 / 3, 9);
  });
});
