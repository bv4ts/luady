import { TILE, type PixelPoint, type TilePoint, type WalkMask } from './types.js';
import { guideOf, type WalkGuide } from './walk-guide.js';

/** One number per tile, row by row, on a grid `width` tiles wide. */
export function tileKey(tx: number, ty: number, width: number): number {
  return ty * width + tx;
}

/** Rows of booleans (walkGrid) or a mask (walkMask). */
type Grid = readonly (readonly boolean[])[] | WalkMask;

interface Size { readonly width: number; readonly height: number }

const isMask = (grid: Grid): grid is WalkMask => !Array.isArray(grid);

const sizeOf = (grid: Grid): Size => (isMask(grid) ? { width: grid.width, height: grid.height } : { width: grid[0]?.length ?? 0, height: grid.length });

/** Rows of booleans already read, by grid (walkGrid's grids are frozen, so a grid's bytes never change). */
const READ = new WeakMap<object, Uint8Array>();

/** Open tiles as one byte each, row by row: a mask is used as it is, rows of booleans are read once per grid. */
const openOf = (grid: Grid, size: Size): ArrayLike<number> => {
  if (isMask(grid)) return grid.open;
  const known = READ.get(grid);
  if (known !== undefined && known.length === size.width * size.height) return known;
  const open = new Uint8Array(size.width * size.height);
  grid.forEach((row, y) => row.forEach((v, x) => { if (v) open[y * size.width + x] = 1; }));
  if (Object.isFrozen(grid)) READ.set(grid, open);
  return open;
};

const inMap = (t: TilePoint, size: Size): boolean =>
  Number.isInteger(t.tx) && Number.isInteger(t.ty) && t.tx >= 0 && t.ty >= 0 && t.tx < size.width && t.ty < size.height;

const centreOf = (tx: number, ty: number): PixelPoint => Object.freeze({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 });

/*
 * Search buffers, reused from call to call: a tile's g and predecessor count only when its stamp is
 * this search's generation, so nothing is cleared between searches. They grow with the largest grid seen.
 */
let capacity = 0;
let seen = new Uint32Array(0);
let done = new Uint32Array(0);
let cost = new Int32Array(0);
let from = new Int32Array(0);
let generation = 0;
let heapNodes = new Int32Array(256);
let heapKeys = new Float64Array(256);
let heapSize = 0;
let visits = 0;

const prepare = (tiles: number): void => {
  if (tiles > capacity) {
    capacity = tiles;
    seen = new Uint32Array(tiles);
    done = new Uint32Array(tiles);
    cost = new Int32Array(tiles);
    from = new Int32Array(tiles);
    generation = 0;
  }
  if (generation === 0xffffffff) {
    seen.fill(0);
    done.fill(0);
    generation = 0;
  }
  generation += 1;
  heapSize = 0;
  visits = 0;
};

const push = (node: number, key: number): void => {
  if (heapSize === heapNodes.length) {
    const nodes = new Int32Array(heapSize * 2);
    const keys = new Float64Array(heapSize * 2);
    nodes.set(heapNodes);
    keys.set(heapKeys);
    heapNodes = nodes;
    heapKeys = keys;
  }
  let i = heapSize;
  heapSize += 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if ((heapKeys[parent] ?? 0) <= key) break;
    heapNodes[i] = heapNodes[parent] ?? 0;
    heapKeys[i] = heapKeys[parent] ?? 0;
    i = parent;
  }
  heapNodes[i] = node;
  heapKeys[i] = key;
};

const pop = (): number => {
  const top = heapNodes[0] ?? -1;
  heapSize -= 1;
  const node = heapNodes[heapSize] ?? 0;
  const key = heapKeys[heapSize] ?? 0;
  let i = 0;
  for (;;) {
    let child = 2 * i + 1;
    if (child >= heapSize) break;
    if (child + 1 < heapSize && (heapKeys[child + 1] ?? 0) < (heapKeys[child] ?? 0)) child += 1;
    if ((heapKeys[child] ?? 0) >= key) break;
    heapNodes[i] = heapNodes[child] ?? 0;
    heapKeys[i] = heapKeys[child] ?? 0;
    i = child;
  }
  if (heapSize > 0) {
    heapNodes[i] = node;
    heapKeys[i] = key;
  }
  return top;
};

/**
 * A* over 4 neighbours with the Manhattan distance, on a binary heap; ties go to the tile nearer the goal, which keeps
 * walks straight. With a guide (grids from walkMask and walkGrid) it skips the rooms that hold neither end: a room has
 * one door, so a shortest walk never passes through one. Afterwards `from` holds each reached tile's predecessor.
 */
const search = (open: ArrayLike<number>, size: Size, start: number, goal: number, extraBlocked: ReadonlySet<number> | undefined, pockets: WalkGuide | undefined): boolean => {
  const { width, height } = size;
  prepare(width * height);
  const gx = goal % width;
  const gy = (goal - gx) / width;
  const sx = start % width;
  const sy = (start - sx) / width;
  const mine = pockets === undefined ? -1 : pockets.pocketOf(sx, sy);
  const theirs = pockets === undefined ? -1 : pockets.pocketOf(gx, gy);
  const foreign = (x: number, y: number): boolean => {
    if (pockets === undefined) return false;
    const p = pockets.pocketOf(x, y);
    return p >= 0 && p !== mine && p !== theirs;
  };
  const scale = width + height + 1;
  const h = (x: number, y: number): number => Math.abs(x - gx) + Math.abs(y - gy);
  seen[start] = generation;
  cost[start] = 0;
  from[start] = start;
  push(start, h(sx, sy) * scale + h(sx, sy));
  while (heapSize > 0) {
    const cur = pop();
    if (done[cur] === generation) continue;
    done[cur] = generation;
    visits += 1;
    if (cur === goal) return true;
    const cx = cur % width;
    const cy = (cur - cx) / width;
    const next = (cost[cur] ?? 0) + 1;
    for (let d = 0; d < 4; d += 1) {
      const nx = d === 0 ? cx + 1 : d === 1 ? cx - 1 : cx;
      const ny = d === 2 ? cy + 1 : d === 3 ? cy - 1 : cy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const k = ny * width + nx;
      if (done[k] === generation) continue;
      if (k !== goal && (open[k] !== 1 || (extraBlocked?.has(k) ?? false))) continue;
      if (seen[k] === generation && (cost[k] ?? 0) <= next) continue;
      if (foreign(nx, ny)) continue;
      seen[k] = generation;
      cost[k] = next;
      from[k] = cur;
      const rest = h(nx, ny);
      push(k, (next + rest) * scale + rest);
    }
  }
  return false;
};

/** Tiles the last findPath search took off its heap (the operation count the tests assert). */
export function lastPathVisits(): number {
  return visits;
}

/** Keeps the corners of a tile-by-tile route and its last point. */
const corners = (width: number, start: number, cells: readonly number[]): readonly PixelPoint[] => {
  const keyCentre = (k: number): PixelPoint => centreOf(k % width, Math.floor(k / width));
  const pts = cells.map(keyCentre);
  return pts.filter((p, i) => {
    if (i === pts.length - 1) return true;
    const a = i === 0 ? keyCentre(start) : pts[i - 1];
    const b = pts[i + 1];
    if (a === undefined || b === undefined) return true;
    return !((a.x === p.x && p.x === b.x) || (a.y === p.y && p.y === b.y));
  });
};

/**
 * Shortest walk from one tile to another, as tile-centre pixels at each turn, ending at the goal centre (A*). The
 * grid's size is its own (`grid[0].length` by `grid.length`, or a mask's width and height), and
 * `extraBlocked` holds tileKey(tx, ty, that width) numbers. The goal itself may be blocked (a desk, a chair).
 * Already there: []. Unreachable or off the map: [goal centre].
 */
export function findPath(grid: Grid, start: TilePoint, to: TilePoint, extraBlocked?: ReadonlySet<number>): readonly PixelPoint[] {
  if (start.tx === to.tx && start.ty === to.ty) return Object.freeze([]);
  const fallback = Object.freeze([centreOf(to.tx, to.ty)]);
  const size = sizeOf(grid);
  if (!inMap(start, size) || !inMap(to, size)) return fallback;
  const first = tileKey(start.tx, start.ty, size.width);
  const goal = tileKey(to.tx, to.ty, size.width);
  const open = openOf(grid, size);
  const pockets = guideOf(grid);
  const found = search(open, size, first, goal, extraBlocked, pockets) || (pockets !== undefined && search(open, size, first, goal, extraBlocked, undefined));
  if (!found) return fallback;
  const cells: number[] = [];
  for (let k = goal; k !== first; k = from[k] ?? first) cells.push(k);
  return Object.freeze(corners(size.width, first, cells.toReversed()));
}
