import { describe, expect, it } from 'vitest';
import { classicRooms } from './rooms-fixture.js';
import { slotsFor, type DeskMode, type DeskSlot } from '../src/desks.js';
import { buildOffice, type OfficeMap } from '../src/layout.js';
import { findPath, tileKey } from '../src/path.js';
import { propsFor } from '../src/props.js';
import { isFurnished } from '../src/rooms.js';
import { walkGrid, type WalkGrid } from '../src/walk.js';
import { centre, open, tileOf, walkable } from './route.js';

const SERVERS = ['cedar', 'birch', 'ash', 'local'] as const;

/** A classic office: the classic rooms of these servers. */
const officeOf = (servers: readonly string[]): OfficeMap => buildOffice(classicRooms(servers));

/** The furnished rooms of a map (the classic servers' rooms). */
const furnished = (map: OfficeMap): readonly string[] => map.order.filter((key) => isFurnished(map.rooms[key]!));

/** Every desk of the mode, with the lounge on in normal mode (the most crowded floor) and off in tight mode. */
const gridFor = (map: OfficeMap, mode: DeskMode): { grid: WalkGrid; slots: Record<string, readonly DeskSlot[]> } => {
  const lounge = Object.fromEntries(furnished(map).map((s) => [s, mode === 'normal']));
  const slots = Object.fromEntries(furnished(map).map((s) => [s, slotsFor(map.rooms[s]!, mode)]));
  return { grid: walkGrid(map, slots, propsFor(map, lounge)), slots };
};

describe('walkGrid (classic offices)', () => {
  const map = officeOf(SERVERS);
  const { grid, slots } = gridFor(map, 'normal');

  it('is ROWS x COLS and frozen', () => {
    expect(grid).toHaveLength(42);
    expect(grid.every((row) => row.length === 84)).toBe(true);
    expect(Object.isFrozen(grid)).toBe(true);
    expect(Object.isFrozen(grid[0])).toBe(true);
  });

  it('opens corridors, doors, entries and room floors', () => {
    [{ tx: 0, ty: 20 }, { tx: 83, ty: 21 }, { tx: 27, ty: 20 }, { tx: 56, ty: 21 }, { tx: 21, ty: 17 }, { tx: 62, ty: 25 }, { tx: 42, ty: 22 }, { tx: 20, ty: 22 }, { tx: 70, ty: 22 }]
      .forEach((t) => expect(open(grid, t)).toBe(true));
  });

  it('closes walls, the void, furniture and desks', () => {
    const desk = slots.birch?.[0]?.blocks[0];
    [{ tx: 0, ty: 0 }, { tx: 1, ty: 5 }, { tx: 10, ty: 2 }, { tx: 24, ty: 3 }, { tx: 41, ty: 19 }, { tx: 9, ty: 18 }, { tx: 82, ty: 18 }, { tx: 83, ty: 19 }, { tx: 44, ty: 3 }, { tx: 30, ty: 8 }, desk ?? { tx: -1, ty: -1 }]
      .forEach((t) => expect(open(grid, t)).toBe(false));
  });

  it('keeps a lot and its door closed', () => {
    const small = officeOf(['birch']);
    const g = gridFor(small, 'normal').grid;
    expect(open(g, { tx: 62, ty: 14 })).toBe(false);
    expect(open(g, { tx: 61, ty: 17 })).toBe(false);
    expect(open(g, { tx: 21, ty: 14 })).toBe(true);
  });
});

describe('findPath (classic offices)', () => {
  const map = officeOf(SERVERS);
  const { grid } = gridFor(map, 'normal');

  it('walks from Luady home to the Orchard room through open floor, corners only', () => {
    const path = findPath(grid, map.spots.luadyHome, map.rooms.birch!.inside);
    expect(path.length).toBeGreaterThan(0);
    expect(path.at(-1)).toEqual({ x: 21 * 16 + 8, y: 14 * 16 + 8 });
    path.slice(1).forEach((p, i) => {
      const q = path[i]!;
      expect(p.x === q.x || p.y === q.y).toBe(true);
    });
    path.slice(0, -1).forEach((p) => expect(open(grid, tileOf(p))).toBe(true));
    expect(walkable(grid, map.spots.luadyHome, path)).toBe(true);
  });

  it('keeps only turning points', () => {
    const path = findPath(grid, { tx: 2, ty: 20 }, { tx: 20, ty: 20 });
    expect(path).toEqual([{ x: 328, y: 328 }]);
  });

  it('returns no steps when already there', () => {
    expect(findPath(grid, map.spots.bench, map.spots.bench)).toEqual([]);
  });

  it('returns one point at the target centre when the target is outside the map', () => {
    expect(findPath(grid, map.spots.luadyHome, { tx: 84, ty: 5 })).toEqual([{ x: 1352, y: 88 }]);
    expect(findPath(grid, map.spots.luadyHome, { tx: -1, ty: -1 })).toEqual([{ x: -8, y: -8 }]);
    expect(findPath(grid, map.spots.luadyHome, { tx: 2.5, ty: 3 })).toHaveLength(1);
  });

  it('returns one point at the target centre when the start is outside the map', () => {
    expect(findPath(grid, { tx: 99, ty: 99 }, map.spots.bench)).toEqual([centre(map.spots.bench)]);
  });

  it('returns one point at the target centre when the target is walled in', () => {
    expect(findPath(grid, map.spots.luadyHome, { tx: 0, ty: 0 })).toEqual([{ x: 8, y: 8 }]);
  });

  it('may end on a blocked goal tile', () => {
    const path = findPath(grid, map.spots.luadyHome, { tx: 41, ty: 19 });
    expect(path.at(-1)).toEqual(centre({ tx: 41, ty: 19 }));
    expect(path.length).toBeGreaterThan(0);
    expect(walkable(grid, map.spots.luadyHome, path)).toBe(true);
  });

  it('steps around extra blocked tiles', () => {
    const plain = findPath(grid, { tx: 2, ty: 20 }, { tx: 20, ty: 20 });
    const around = findPath(grid, { tx: 2, ty: 20 }, { tx: 20, ty: 20 }, new Set([tileKey(10, 20, 84)]));
    expect(around.length).toBeGreaterThan(plain.length);
    expect(around.some((p) => p.y !== 328)).toBe(true);
  });

  it('gives up with one point when extra blocks wall the target off', () => {
    const wall = new Set([tileKey(20, 19, 84), tileKey(21, 20, 84), tileKey(19, 20, 84), tileKey(20, 21, 84)]);
    expect(findPath(grid, { tx: 2, ty: 20 }, { tx: 20, ty: 20 }, wall)).toEqual([{ x: 328, y: 328 }]);
  });

  it('numbers tiles row by row, on a grid of the given width', () => {
    expect(tileKey(0, 0, 84)).toBe(0);
    expect(tileKey(3, 2, 84)).toBe(171);
    expect(tileKey(3, 2, 136)).toBe(275);
  });
});

describe('every desk can be reached from both entries (classic offices)', () => {
  it.each(['normal', 'tight'] as DeskMode[])('in %s mode', (mode) => {
    const map = officeOf(SERVERS);
    const { grid, slots } = gridFor(map, mode);
    expect(map.spots.entries).toHaveLength(2);
    map.spots.entries.forEach((entry) => {
      SERVERS.forEach((server) => {
        (slots[server] ?? []).forEach((slot) => {
          const path = findPath(grid, entry, slot.tile);
          expect(path.length).toBeGreaterThanOrEqual(1);
          expect(walkable(grid, entry, path)).toBe(true);
        });
      });
    });
  });

  it('with Jira boards hung in every room', () => {
    const map = officeOf(SERVERS);
    const slots = Object.fromEntries(furnished(map).map((s) => [s, slotsFor(map.rooms[s]!, 'tight')]));
    const grid = walkGrid(map, slots, propsFor(map, {}, { jiraRooms: SERVERS }));
    map.spots.entries.forEach((entry) => {
      Object.values(slots).flat().forEach((slot) => expect(walkable(grid, entry, findPath(grid, entry, slot.tile))).toBe(true));
    });
  });
});

describe('HQ spots (classic offices)', () => {
  it.each(['normal', 'tight'] as DeskMode[])('are open and reachable from both entries in %s mode', (mode) => {
    const map = officeOf(SERVERS);
    const { grid } = gridFor(map, mode);
    const doors = [{ tx: 28, ty: 20 }, { tx: 28, ty: 21 }, { tx: 55, ty: 20 }, { tx: 55, ty: 21 }];
    const spots = [map.spots.luadyHome, map.spots.taskWall, map.spots.bench, map.spots.benchVisit, map.rooms.hq!.inside, ...doors];
    spots.forEach((spot) => {
      expect(open(grid, spot)).toBe(true);
      map.spots.entries.forEach((entry) => expect(walkable(grid, entry, findPath(grid, entry, spot))).toBe(true));
    });
  });
});

describe('the task wall in front of the HQ board (classic offices)', () => {
  const subsets = Array.from({ length: 16 }, (_, bits) => SERVERS.filter((_, i) => (bits & (1 << i)) !== 0));

  it.each(subsets.map((s) => [s.join(',') || '(none)', s] as const))('is open floor and reachable with servers %s', (_name, servers) => {
    const map = officeOf(servers);
    expect(map.spots.taskWall).toEqual({ tx: 33, ty: 3 });
    (['normal', 'tight'] as DeskMode[]).forEach((mode) => {
      const { grid } = gridFor(map, mode);
      expect(open(grid, map.spots.taskWall)).toBe(true);
      [...map.spots.entries, map.spots.luadyHome].forEach((from) => {
        const path = findPath(grid, from, map.spots.taskWall);
        expect(path.at(-1)).toEqual(centre(map.spots.taskWall));
        expect(walkable(grid, from, path)).toBe(true);
      });
    });
  });
});
