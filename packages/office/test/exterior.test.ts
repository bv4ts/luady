import { describe, expect, it } from 'vitest';
import { CLASSIC_ROOMS, classicRooms } from './rooms-fixture.js';
import { buildOffice } from '../src/layout.js';
import { hashBytes } from '../src/looks.js';
import { pixelAt, type Raster } from '../src/raster.js';
import { EXTERIOR_MARGIN, EXTERIOR_RIM, LAWN_CLEAR, exteriorRaster, lampFeet, treeKeepClear } from '../src/sprites/exterior.js';
import { treeArea, treeSpots } from '../src/sprites/groves.js';
import { GROUND_TILE, groundRaster } from '../src/sprites/ground.js';

const M = EXTERIOR_MARGIN;
const alpha = (r: Raster, x: number, y: number): number => pixelAt(r, x, y)[3];
const key = (r: Raster, x: number, y: number): string => pixelAt(r, x, y).join();

describe('groundRaster', () => {
  const ground = groundRaster();

  it('is a 64 × 64 opaque tile', () => {
    expect(GROUND_TILE).toBe(64);
    expect([ground.width, ground.height]).toEqual([64, 64]);
    for (let i = 3; i < ground.data.length; i += 4) expect(ground.data[i]).toBe(255);
  });

  it('is textured, in dark greens', () => {
    const colours = new Set<string>();
    for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) colours.add(key(ground, x, y));
    expect(colours.size).toBeGreaterThanOrEqual(5);
    let greener = 0;
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const [r, g, b] = pixelAt(ground, x, y);
        expect(r + g + b).toBeLessThan(3 * 110);
        if (g > r && g >= b) greener += 1;
      }
    }
    expect(greener).toBeGreaterThan(64 * 64 * 0.8);
  });

  /** How many pixels differ between two columns (or rows) of the tile. */
  const columnDiff = (a: number, b: number): number => Array.from({ length: 64 }, (_, y) => y).filter((y) => key(ground, a, y) !== key(ground, b, y)).length;
  const rowDiff = (a: number, b: number): number => Array.from({ length: 64 }, (_, x) => x).filter((x) => key(ground, x, a) !== key(ground, x, b)).length;

  it('repeats without a seam: the step across an edge is no harsher than a step inside the tile', () => {
    const inside = Array.from({ length: 63 }, (_, i) => i);
    expect(columnDiff(63, 0)).toBeLessThanOrEqual(Math.max(...inside.map((i) => columnDiff(i, i + 1))));
    expect(rowDiff(63, 0)).toBeLessThanOrEqual(Math.max(...inside.map((i) => rowDiff(i, i + 1))));
    const meanColumns = inside.reduce((sum, i) => sum + columnDiff(i, i + 1), 0) / inside.length;
    expect(columnDiff(63, 0)).toBeLessThanOrEqual(meanColumns * 2 + 2);
  });

  it('draws the same tile every time', () => {
    expect(groundRaster().data).toEqual(ground.data);
  });
});

describe('exteriorRaster', () => {
  const map = buildOffice(classicRooms(['cedar', 'birch', 'ash', 'local']));
  const outside = exteriorRaster(map);
  const building = { x: M + 16, y: M + 16, w: 1312, h: 640 };

  it('reaches EXTERIOR_MARGIN past the map on every side', () => {
    expect(EXTERIOR_MARGIN).toBe(320);
    expect([outside.width, outside.height]).toEqual([1344 + 640, 672 + 640]);
  });

  it('is transparent over the building, which is drawn on top of it', () => {
    for (let y = building.y; y < building.y + building.h; y += 3) {
      for (let x = building.x; x < building.x + building.w; x += 3) {
        if (alpha(outside, x, y) !== 0) throw new Error(`opaque at ${x},${y}`);
      }
    }
  });

  it('paves a rim round the walls and casts the building shadow on it, right and below', () => {
    [[building.x - 4, building.y + 100], [building.x + 500, building.y - 4], [building.x + building.w + 12, building.y + 200], [building.x + 300, building.y + building.h + 16]]
      .forEach(([x, y]) => expect(alpha(outside, x ?? 0, y ?? 0)).toBe(255));
    const rimStone = pixelAt(outside, building.x + building.w + 15, building.y + 150);
    const shadow = pixelAt(outside, building.x + building.w + 3, building.y + 150);
    expect(shadow[3]).toBe(255);
    expect(shadow[0] + shadow[1] + shadow[2]).toBeLessThan(rimStone[0] + rimStone[1] + rimStone[2]);
    expect(pixelAt(outside, building.x + 300, building.y + building.h + 4)).toEqual(shadow);
    expect(key(outside, building.x - 4, building.y + 150)).not.toBe(shadow.join());
    expect(EXTERIOR_RIM).toBeGreaterThanOrEqual(16);
  });

  it('runs a path from each entry to the edge of the picture', () => {
    const picture = outside;
    const pathY = M + 21 * 16;
    for (let x = 0; x < building.x; x += 4) expect([x, alpha(picture, x, pathY)]).toEqual([x, 255]);
    for (let x = building.x + building.w; x < picture.width; x += 4) expect([x, alpha(picture, x, pathY)]).toEqual([x, 255]);
  });

  it('leaves most of the garden to the grass beneath it', () => {
    let clear = 0;
    let total = 0;
    for (let y = 0; y < outside.height; y += 4) {
      for (let x = 0; x < outside.width; x += 4) {
        const inBuilding = x >= building.x && x < building.x + building.w && y >= building.y && y < building.y + building.h;
        if (inBuilding) continue;
        total += 1;
        if (alpha(outside, x, y) === 0) clear += 1;
      }
    }
    expect(clear / total).toBeGreaterThan(0.4);
    expect(clear / total).toBeLessThan(0.95);
  });

  it('has lamps with a warm light', () => {
    let warm = 0;
    for (let i = 0; i < outside.data.length; i += 4) if (outside.data[i] === 0xff && outside.data[i + 1] === 0xd9 && outside.data[i + 2] === 0x8a) warm += 1;
    expect(warm).toBeGreaterThanOrEqual(10);
  });

  it('draws the same pixels every time', () => {
    expect(hashBytes(exteriorRaster(map).data)).toBe(hashBytes(outside.data));
  });
});

describe('the garden round the building', () => {
  const map = buildOffice(classicRooms(['cedar', 'birch', 'ash', 'local']));
  const outside = exteriorRaster(map);
  const ground = groundRaster();
  const rim = { x: M + 16 - EXTERIOR_RIM, y: M + 16 - EXTERIOR_RIM, w: 1312 + EXTERIOR_RIM * 2, h: 640 + EXTERIOR_RIM * 2 };
  const trees = treeSpots(outside.width, outside.height, treeKeepClear(map));

  it('gathers its trees in groves with open lawn between them, in many sizes', () => {
    expect(trees.length).toBeGreaterThan(60);
    expect(new Set(trees.map((t) => t.r)).size).toBeGreaterThanOrEqual(7);
    const cell = 200;
    const counts = new Map<string, number>();
    trees.forEach((t) => {
      const key = `${Math.floor(t.x / cell)},${Math.floor(t.y / cell)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    const cells = Math.ceil(outside.width / cell) * Math.ceil(outside.height / cell);
    expect(cells - counts.size).toBeGreaterThan(cells * 0.3);
    expect(Math.max(...counts.values())).toBeGreaterThanOrEqual(6);
  });

  it('keeps two tiles of clear lawn past the hedges round the rim', () => {
    expect(LAWN_CLEAR).toBe(32);
    const near = { x: rim.x - LAWN_CLEAR - 16, y: rim.y - LAWN_CLEAR - 16, w: rim.w + (LAWN_CLEAR + 16) * 2, h: rim.h + (LAWN_CLEAR + 16) * 2 };
    trees.map(treeArea).forEach((a) => {
      expect(a.x < near.x + near.w && near.x < a.x + a.w && a.y < near.y + near.h && near.y < a.y + a.h).toBe(false);
    });
  });

  it('lights a warm pool on the ground under every lamp, over grass as well as stone', () => {
    const feet = lampFeet(map);
    expect(feet.length).toBeGreaterThanOrEqual(10);
    feet.forEach(([x, y]) => {
      const [r, , b, a] = pixelAt(outside, x + 10, y + 2);
      expect(a).toBe(255);
      expect(r).toBeGreaterThan(b);
    });
    const [fx, fy] = feet[0]!;
    const litGrass = [-3, -2, -1, 0, 1, 2, 3].filter((dx) => {
      const lit = pixelAt(outside, fx + dx, fy - 8);
      return lit[3] === 255 && lit[0] > pixelAt(ground, (fx + dx) % 64, (fy - 8) % 64)[0];
    });
    expect(litGrass.length).toBeGreaterThan(0);
  });
});
