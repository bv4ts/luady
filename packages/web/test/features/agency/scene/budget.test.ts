import { HQ_ID, buildOffice, chunkWorldRect, type OfficeMap, type PixelPoint, type PixelRect } from '@luady/office';
import { describe, expect, it } from 'vitest';
import { clampCenter, fitZoom, wholeOfficeFit } from '../../../../src/features/agency/scene/camera-math.js';
import {
  CHUNK_MARGIN_CSS, FAR_ROOMS, chunkBudget, chunkBytes, isFar, layersOf, liveChunks, liveRooms, lodFor, objectBound,
} from '../../../../src/features/agency/scene/live-set.js';
import type { StageInsets } from '../../../../src/features/agency/stage-types.js';
import { roomsOf } from './office-fixtures.js';

/**
 * The scene's budgets, from geometry alone (nothing is painted): for every office size, screen, zoom and pan
 * the chunks the scene keeps fit the chunk budget, no texture is larger than 512 px, and detailed mode never has more
 * display objects than the bound allows.
 */

const MIB = 1024 * 1024;
const NONE: StageInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const BARS: StageInsets = { top: 56, right: 0, bottom: 64, left: 0 };
const SIZES = [0, 1, 4, 5, 24, 100, 300] as const;
const VIEWPORTS = [
  { name: '390×844', width: 390, height: 844 },
  { name: '1440×900', width: 1440, height: 900 },
  { name: '1920×1080', width: 1920, height: 1080 },
  { name: '3840×2160', width: 3840, height: 2160 },
] as const;
const FIXED_SCALES = [0.45, 0.75, 1, 2.6, 4] as const;
const PANS = [0, 0.5, 1] as const;

interface Case {
  readonly n: number; readonly viewport: (typeof VIEWPORTS)[number]; readonly label: string; readonly scale: number;
  readonly map: OfficeMap; readonly view: PixelRect; readonly centre: PixelPoint;
}

const viewAt = (centre: PixelPoint, scale: number, width: number, height: number): PixelRect =>
  ({ x: centre.x - width / 2 / scale, y: centre.y - height / 2 / scale, w: width / scale, h: height / scale });

/** Every reachable zoom (none below the whole-office fit) at nine pans over the building, as the camera clamps them. */
const cases = (): readonly Case[] => SIZES.flatMap((n) => {
  const map = buildOffice(roomsOf(n));
  return VIEWPORTS.flatMap((viewport) => {
    const size = { width: viewport.width, height: viewport.height };
    const fit = fitZoom(map, size, BARS);
    const scales: [string, number][] = [['fit', fit], ['opening', wholeOfficeFit(map, size, BARS).scale], ...FIXED_SCALES.map((s): [string, number] => [String(s), s])];
    return scales.filter(([, s]) => s >= fit - 1e-9).flatMap(([label, scale]) => PANS.flatMap((fx) => PANS.map((fy) => {
      const all = map.zones.all;
      const centre = clampCenter({ x: all.x + all.w * fx, y: all.y + all.h * fy }, scale, size, NONE, all);
      return { n, viewport, label, scale, map, view: viewAt(centre, scale, viewport.width, viewport.height), centre };
    })));
  });
});

const CASES = cases();

const chunkTotals = (c: Case): { bytes: number; side: number } => {
  const lod = lodFor(c.scale);
  let bytes = 0;
  let side = 0;
  liveChunks(c.map, c.view, c.scale, c.centre).forEach(({ i, j }) => layersOf(c.map, i, j).forEach((layer) => {
    const r = chunkWorldRect(c.map, layer, i, j);
    bytes += chunkBytes(c.map, layer, i, j, lod);
    side = Math.max(side, Math.ceil(r.w / lod), Math.ceil(r.h / lod));
  }));
  return { bytes, side };
};

describe('chunk memory', () => {
  it('covers every size, screen, zoom and pan', () => {
    expect(CASES.length).toBeGreaterThan(SIZES.length * VIEWPORTS.length * 9 * 3);
  });

  it('keeps the live chunks within 33 MiB + 46 B per CSS pixel, and every texture at most 512 px', () => {
    const worst = new Map<string, number>();
    CASES.forEach((c) => {
      const { bytes, side } = chunkTotals(c);
      const budget = chunkBudget(c.viewport.width, c.viewport.height);
      expect(bytes, `${c.n} rooms, ${c.viewport.name}, ${c.label}`).toBeLessThanOrEqual(budget);
      expect(side).toBeLessThanOrEqual(512);
      worst.set(c.viewport.name, Math.max(worst.get(c.viewport.name) ?? 0, bytes));
    });
    console.info(`[budget] worst live chunk MiB: ${[...worst].map(([v, b]) => `${v} ${(b / MIB).toFixed(1)}`).join(', ')}`);
  });

  it('states the budget in MiB', () => {
    expect(chunkBudget(390, 844) / MIB).toBeCloseTo(47.44, 2);
    expect(chunkBudget(1440, 900) / MIB).toBeCloseTo(89.85, 2);
    expect(chunkBudget(1920, 1080) / MIB).toBeCloseTo(123.97, 2);
  });

  it('counts the cropped rectangle of an edge chunk, not the full 512-pixel frame', () => {
    const map = buildOffice(roomsOf(4));
    const i = map.chunks.cols - 1;
    const j = map.chunks.rows - 1;
    const r = chunkWorldRect(map, 'exterior', i, j);
    expect([r.w, r.h]).toEqual([1984 - 512 * 3, 1312 - 512 * 2]);
    expect(chunkBytes(map, 'exterior', i, j, 1)).toBe(r.w * r.h * 4);
    expect(chunkBytes(map, 'exterior', i, j, 4)).toBe(Math.ceil(r.w / 4) * Math.ceil(r.h / 4) * 4);
  });

  it('keeps the classic four within 17,637,376 bytes, the size of three whole-map textures, whole office in view at lod 1', () => {
    const map = buildOffice(roomsOf(4));
    const view = { x: -320, y: -320, w: map.width + 640, h: map.height + 640 };
    const bytes = liveChunks(map, view, 1, { x: 672, y: 336 }, CHUNK_MARGIN_CSS)
      .reduce((n, { i, j }) => n + layersOf(map, i, j).reduce((m, layer) => m + chunkBytes(map, layer, i, j, 1), 0), 0);
    expect(bytes).toBeLessThanOrEqual(17_637_376);
    expect(bytes / MIB).toBeLessThanOrEqual(17);
  });
});

describe('liveChunks and liveRooms', () => {
  const map = buildOffice(roomsOf(24));

  it('takes the chunks meeting the view grown by 192 CSS pixels, nearest the centre first', () => {
    // Chunk column 3 starts at world x = -320 + 3 × 512 = 1216.
    const near = { x: 0, y: 0, w: 1216 - 191, h: 100 };
    const far = { x: 0, y: 0, w: 1216 - 193, h: 100 };
    expect(liveChunks(map, near, 1, { x: 0, y: 0 }).some((c) => c.i === 3)).toBe(true);
    expect(liveChunks(map, far, 1, { x: 0, y: 0 }).some((c) => c.i === 3)).toBe(false);
    expect(liveChunks(map, far, 2, { x: 0, y: 0 }).some((c) => c.i === 3)).toBe(false);
    const order = liveChunks(map, map.zones.all, 0.5, { x: 1500, y: 600 }).map((c) => c.distance);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('takes the rooms meeting the view grown by one room, HQ left out', () => {
    const hq = map.zones.hq;
    // HQ is 480 px wide: a 50-pixel view at its centre grown by half a room (208 px) on each side stays inside it.
    expect(liveRooms(map, { x: hq.x + hq.w / 2 - 25, y: hq.y + hq.h / 2 - 25, w: 50, h: 50 })).toEqual([]);
    expect(liveRooms(map, { x: hq.x - 207, y: hq.y + hq.h / 2, w: 1, h: 1 }).length).toBeGreaterThan(0);
    const all = liveRooms(map, map.zones.all);
    expect(all.map((r) => r.id)).toEqual(map.order.filter((id) => id !== HQ_ID));
  });
});

describe('display objects and far mode', () => {
  it('switches to far mode beyond 80 live rooms, whatever the zoom', () => {
    let beyond = 0;
    CASES.forEach((c) => {
      const live = liveRooms(c.map, c.view);
      if (live.length > FAR_ROOMS) {
        beyond += 1;
        expect(isFar(c.scale, live)).toBe(true);
      }
    });
    expect(beyond).toBeGreaterThan(0);
    expect(isFar(0.4499, [])).toBe(true);
    expect(isFar(0.45, Array.from({ length: FAR_ROOMS }))).toBe(false);
    expect(isFar(4, Array.from({ length: FAR_ROOMS + 1 }))).toBe(true);
  });

  it('keeps detailed mode within 13,160 objects at every screen, and 10,000 with the demo seed', () => {
    let detailed = 0;
    CASES.forEach((c) => {
      const live = liveRooms(c.map, c.view);
      if (isFar(c.scale, live)) return;
      detailed += 1;
      expect(objectBound(live.length, 12), `${c.n} rooms, ${c.viewport.name}, ${c.label}`).toBeLessThanOrEqual(13_160);
      expect(objectBound(live.length, 3)).toBeLessThanOrEqual(10_000);
    });
    expect(detailed).toBeGreaterThan(0);
  });

  it('keeps a 390×844 phone within 3,000 objects with the demo seed', () => {
    let worst = 0;
    CASES.filter((c) => c.viewport.width === 390).forEach((c) => {
      const live = liveRooms(c.map, c.view);
      if (isFar(c.scale, live)) return;
      const objects = objectBound(live.length, 3);
      expect(objects, `${c.n} rooms, ${c.label}`).toBeLessThanOrEqual(3_000);
      worst = Math.max(worst, objects);
    });
    console.info(`[budget] 390×844 detailed mode, demo seed: at most ${worst} objects by the display-object bound`);
  });

  it('keeps the e2e viewport (1440×900) in detailed mode at 0.45 on every pan', () => {
    CASES.filter((c) => c.viewport.width === 1440 && c.label === '0.45').forEach((c) => {
      expect(liveRooms(c.map, c.view).length, `${c.n} rooms`).toBeLessThanOrEqual(FAR_ROOMS);
    });
  });
});
