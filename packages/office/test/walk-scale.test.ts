import { describe, expect, it } from 'vitest';
import { slotsFor, type DeskSlot } from '../src/desks.js';
import { geometryOf } from '../src/grid.js';
import { buildOffice, type OfficeMap } from '../src/layout.js';
import { findPath, lastPathVisits, tileKey } from '../src/path.js';
import { propsFor, type PropDef } from '../src/props.js';
import { isFurnished } from '../src/rooms.js';
import type { PixelPoint, TilePoint, WalkMask } from '../src/types.js';
import { walkGrid, walkMask, walkMaskBuilds } from '../src/walk.js';
import { rooms } from './rooms-fixture.js';
import { seeded } from './seeded.js';

const SIZES = [0, 1, 4, 5, 24, 100, 300] as const;

/** Every furnished room's desks in tight mode (the most crowded floor) and its props with every lounge in. */
const crowded = (map: OfficeMap): { slots: Record<string, readonly DeskSlot[]>; props: readonly PropDef[] } => {
  const furnished = map.order.filter((key) => isFurnished(map.rooms[key]!));
  return { slots: Object.fromEntries(furnished.map((key) => [key, slotsFor(map.rooms[key]!, 'tight')])), props: propsFor(map, {}) };
};

/** Every tile one flood fill over the mask reaches from the given starts. */
const reach = (mask: WalkMask, from: readonly TilePoint[]): Uint8Array => {
  const seen = new Uint8Array(mask.width * mask.height);
  const queue = from.map((t) => t.ty * mask.width + t.tx);
  queue.forEach((k) => { seen[k] = 1; });
  for (let i = 0; i < queue.length; i += 1) {
    const k = queue[i] ?? 0;
    const x = k % mask.width;
    const y = (k - x) / mask.width;
    [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]].forEach(([nx = -1, ny = -1]) => {
      if (nx < 0 || ny < 0 || nx >= mask.width || ny >= mask.height) return;
      const n = ny * mask.width + nx;
      if (seen[n] === 1 || mask.open[n] !== 1) return;
      seen[n] = 1;
      queue.push(n);
    });
  }
  return seen;
};

describe.each(SIZES)('walking in an office of %i rooms', (n) => {
  const map = buildOffice(rooms(n));
  const { slots, props } = crowded(map);
  const mask = walkMask(map, slots, props);
  const at = (t: TilePoint): number => t.ty * mask.width + t.tx;

  it('reaches every desk, every room door, HQ and every street door from the street doors, in one flood fill', () => {
    const seen = reach(mask, map.spots.entries);
    Object.values(slots).flat().forEach((slot) => expect(seen[at(slot.tile)]).toBe(1));
    map.order.map((key) => map.rooms[key]!).filter(isFurnished).forEach((room) => {
      const d = room.doorway;
      for (let y = d.y; y < d.y + d.h; y += 1) for (let x = d.x; x < d.x + d.w; x += 1) expect(seen[y * mask.width + x]).toBe(1);
    });
    [map.spots.luadyHome, map.spots.taskWall, map.spots.bench, map.spots.benchVisit, ...map.spots.entries].forEach((t) => expect(seen[at(t)]).toBe(1));
  });

  it('keeps the courts, the lots and the outer walls closed', () => {
    const g = geometryOf(map);
    g.courts.forEach((c) => {
      for (let y = c.y; y < c.y + c.h; y += 1) for (let x = c.x; x < c.x + c.w; x += 1) expect(mask.open[y * mask.width + x]).toBe(0);
    });
    map.order.map((key) => map.rooms[key]!).filter((r) => !isFurnished(r) && r.slot !== null).forEach((lot) => {
      expect(mask.open[(lot.rect.y + 5) * mask.width + lot.rect.x + 5]).toBe(0);
    });
    const inEntry = (x: number, y: number): boolean => g.entries.some((e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h);
    for (let x = 0; x < mask.width; x += 1) {
      expect(mask.open[x]).toBe(0);
      expect([x, mask.open[(mask.height - 1) * mask.width + x] === 1]).toEqual([x, inEntry(x, mask.height - 1)]);
    }
    for (let y = 0; y < mask.height; y += 1) {
      [0, mask.width - 1].forEach((x) => expect([x, y, mask.open[y * mask.width + x] === 1]).toEqual([x, y, inEntry(x, y)]));
    }
  });
});

describe('the static mask', () => {
  it('is built once per layout key, however many snapshots ask', () => {
    const map = buildOffice(rooms(37));
    const { slots, props } = crowded(map);
    walkMask(map, slots, props);
    const before = walkMaskBuilds();
    Array.from({ length: 5 }, () => walkMask(map, slots, props));
    expect(walkMaskBuilds()).toBe(before);
    walkMask(buildOffice(rooms(38)), {}, []);
    expect(walkMaskBuilds()).toBe(before + 1);
  });
});

/** Shortest walk length from `from` to `to` by plain breadth-first search (the goal may be blocked), or -1. */
const bfsLength = (mask: WalkMask, from: TilePoint, to: TilePoint): number => {
  const { width, height, open } = mask;
  const dist = new Int32Array(width * height).fill(-1);
  const start = from.ty * width + from.tx;
  const goal = to.ty * width + to.tx;
  dist[start] = 0;
  const queue = [start];
  for (let i = 0; i < queue.length; i += 1) {
    const k = queue[i] ?? 0;
    if (k === goal) return dist[k] ?? -1;
    const x = k % width;
    const y = (k - x) / width;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const m = ny * width + nx;
      if (dist[m] !== -1 || (open[m] !== 1 && m !== goal)) continue;
      dist[m] = (dist[k] ?? 0) + 1;
      queue.push(m);
    }
  }
  return -1;
};

/** Tiles walked along a path of turning points. */
const lengthOf = (from: TilePoint, path: readonly PixelPoint[]): number => {
  let at = { x: from.tx * 16 + 8, y: from.ty * 16 + 8 };
  return path.reduce((sum, p) => {
    const step = (Math.abs(p.x - at.x) + Math.abs(p.y - at.y)) / 16;
    at = p;
    return sum + step;
  }, 0);
};

const openTiles = (mask: WalkMask): readonly TilePoint[] => {
  const tiles: TilePoint[] = [];
  mask.open.forEach((v, k) => { if (v === 1) tiles.push({ tx: k % mask.width, ty: Math.floor(k / mask.width) }); });
  return tiles;
};

describe('findPath is A*', () => {
  it('finds paths as short as breadth-first search on 200 random pairs at 24 rooms, blocked goals included', () => {
    const map = buildOffice(rooms(24));
    const { slots, props } = crowded(map);
    const mask = walkMask(map, slots, props);
    const grid = walkGrid(map, slots, props);
    const tiles = openTiles(mask);
    const desks = Object.values(slots).flat().map((s) => s.blocks[1]!);
    const random = seeded(24);
    for (let i = 0; i < 200; i += 1) {
      const from = tiles[Math.floor(random() * tiles.length)]!;
      const to = i % 4 === 3 ? desks[Math.floor(random() * desks.length)]! : tiles[Math.floor(random() * tiles.length)]!;
      const want = bfsLength(mask, from, to);
      const path = findPath(grid, from, to);
      const fromMask = findPath(mask, from, to);
      expect(fromMask).toEqual(path);
      if (from.tx === to.tx && from.ty === to.ty) expect(path).toEqual([]);
      else if (want < 0) expect(path).toEqual([{ x: to.tx * 16 + 8, y: to.ty * 16 + 8 }]);
      else expect([i, lengthOf(from, path)]).toEqual([i, want]);
    }
  });

  it('visits fewer than 20,000 tiles for any of 60 random walks at 300 rooms (counted, never timed)', () => {
    const map = buildOffice(rooms(300));
    const { slots, props } = crowded(map);
    const mask = walkMask(map, slots, props);
    const seats = Object.values(slots).flat().map((s) => s.tile);
    const random = seeded(300);
    const visits: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      const from = i % 2 === 0 ? map.spots.entries[Math.floor(random() * map.spots.entries.length)]! : seats[Math.floor(random() * seats.length)]!;
      const to = seats[Math.floor(random() * seats.length)]!;
      const path = findPath(mask, from, to);
      expect(path.length).toBeGreaterThan(0);
      visits.push(lastPathVisits());
    }
    expect(Math.max(...visits)).toBeLessThan(20_000);
  });

  it('takes its width from the grid: extra blocks use tileKey with that width', () => {
    const map = buildOffice(rooms(5));
    const grid = walkGrid(map, {}, []);
    const width = grid[0]!.length;
    expect(width).toBe(136);
    const plain = findPath(grid, { tx: 2, ty: 20 }, { tx: 20, ty: 20 });
    const around = findPath(grid, { tx: 2, ty: 20 }, { tx: 20, ty: 20 }, new Set([tileKey(10, 20, width)]));
    expect(plain).toEqual([{ x: 328, y: 328 }]);
    expect(around.some((p) => p.y !== 328)).toBe(true);
  });
});
