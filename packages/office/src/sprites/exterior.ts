import { MARGIN, geometryOf, type Geometry } from '../grid.js';
import type { OfficeMap } from '../layout.js';
import { createMemo } from '../memo.js';
import { paint, paintWindow, type Painter, type Raster } from '../raster.js';
import { TILE as T, type PixelRect } from '../types.js';
import { STONE, bench, bikeRack, bush, flowerBed, lamp, pond, tree } from './exterior-art.js';
import { groundRaster, hash2 } from './ground.js';
import { treeSpots } from './groves.js';
import { poolBox, withLampLight } from './lamp-light.js';

/** How far the exterior picture reaches past the map on every side, in pixels. */
export const EXTERIOR_MARGIN = 320;
/** Width of the paved rim round the building walls. */
export const EXTERIOR_RIM = 24;
/** The building's drop shadow falls this far right and down. */
const SHADOW = { x: 7, y: 9 } as const;
const PATH_H = 40;
/** HQ's left edge from the building's in the first ring (26 tiles): the garden pieces below and above HQ move with it. */
const FIRST_RING_HQ_PX = 416;
/** Exterior frames are bucketed on the chunk grid: its cells are 512 px from the picture's corner. */
const CELL = 512;

interface Box { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
const box = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** One band's street paths: west from the left edge to its west door, east from its east door to the right edge. */
interface BandPaths { readonly west: Box; readonly east: Box }

/** Where everything goes, in exterior pixels (the map's origin sits at EXTERIOR_MARGIN, EXTERIOR_MARGIN). */
interface Plan {
  readonly w: number; readonly h: number;
  readonly building: Box; readonly rim: Box;
  readonly bands: readonly BandPaths[];
  /** The path down from the south gate below the avenue (R > 1). */
  readonly gate: Box | null;
  /** Every path: the bands' west and east paths in order, then the gate's. */
  readonly paths: readonly Box[];
  readonly beds: readonly Box[];
  readonly pond: { readonly cx: number; readonly cy: number; readonly rx: number; readonly ry: number };
  readonly bench: { readonly x: number; readonly y: number };
  readonly bikes: { readonly x: number; readonly y: number };
}

const bandsOf = (g: Geometry, building: Box, w: number): readonly BandPaths[] =>
  Array.from({ length: g.R }, (_, row) => {
    const entry = g.entries[row * 2];
    const y = (entry?.y ?? 0) * T + EXTERIOR_MARGIN + T - PATH_H / 2;
    return { west: box(0, y, building.x, PATH_H), east: box(building.x + building.w, y, w - building.x - building.w, PATH_H) };
  });

/**
 * The garden's plan for a grid: one path per street door (west and east on every band, plus the south gate's), the
 * beds beside each band's paths, and the pond, bench, south and north beds placed from HQ below and above
 * the building.
 */
const makePlan = (g: Geometry): Plan => {
  const w = g.cols * T + EXTERIOR_MARGIN * 2;
  const h = g.rows * T + EXTERIOR_MARGIN * 2;
  const b = g.building;
  const building = box(b.x * T + EXTERIOR_MARGIN, b.y * T + EXTERIOR_MARGIN, b.w * T, b.h * T);
  const rim = box(building.x - EXTERIOR_RIM, building.y - EXTERIOR_RIM, building.w + EXTERIOR_RIM * 2, building.h + EXTERIOR_RIM * 2);
  const bands = bandsOf(g, building, w);
  const bottom = building.y + building.h;
  const gate = g.R > 1 ? box(g.hqMid * T + EXTERIOR_MARGIN - PATH_H / 2, bottom, PATH_H, h - bottom) : null;
  const bedW = 40;
  /* The building's left edge as it is in the first ring, moved with HQ as columns are added on the west. */
  const anchor = building.x + (g.hqX - MARGIN) * T - FIRST_RING_HQ_PX;
  const beds = [
    ...bands.flatMap(({ west }) => [
      box(rim.x - bedW - 10, west.y - 18, bedW, 12), box(rim.x - bedW - 10, west.y + PATH_H + 6, bedW, 12),
      box(rim.x + rim.w + 10, west.y - 18, bedW, 12), box(rim.x + rim.w + 10, west.y + PATH_H + 6, bedW, 12),
    ]),
    box(anchor + 420, rim.y + rim.h + 8, 56, 12), box(anchor + 840, rim.y - 20, 56, 12),
  ];
  return {
    w, h, building, rim, bands, gate, beds,
    paths: [...bands.flatMap(({ west, east }) => [west, east]), ...(gate === null ? [] : [gate])],
    pond: { cx: anchor + 250, cy: rim.y + rim.h + 32, rx: 40, ry: 15 },
    bench: { x: anchor + 312, y: rim.y + rim.h + 24 },
    bikes: { x: rim.x + rim.w + 14, y: (bands[0]?.east.y ?? 0) + PATH_H + 40 },
  };
};

const PLANS = createMemo<Plan>(8);
const planFor = (map: OfficeMap): Plan => {
  const g = geometryOf(map);
  return PLANS.get(`${g.K}x${g.R}`, () => makePlan(g));
};

/** The last point of the lattice `start + k · step` (k ≥ 0) at or below `lo`, or `start` itself: where a culled loop may begin. */
const latticeFrom = (start: number, step: number, lo: number): number => (lo <= start ? start : start + Math.floor((lo - start) / step) * step);

/**
 * Stones in running bond inside `r`: `sw × sh` stones with a one-pixel joint, two shades picked by position. The bond
 * follows one grid for the whole picture, so strips laid next to each other join without a step. With `cull`, only the
 * stones that meet it are laid (the rest would paint nothing there).
 */
const stones = (p: Painter, r: Box, sw: number, sh: number, a: string, b: string, joint: string, cull: Box | null): void => {
  p.rect(r.x, r.y, r.w, r.h, joint);
  const yEnd = cull === null ? r.y + r.h : Math.min(r.y + r.h, cull.y + cull.h);
  const xEnd = cull === null ? r.x + r.w : Math.min(r.x + r.w, cull.x + cull.w);
  for (let y = latticeFrom(Math.floor(r.y / sh) * sh, sh, cull === null ? r.y : cull.y - sh); y < yEnd; y += sh) {
    const offset = Math.floor(y / sh) % 2 === 0 ? 0 : Math.floor(sw / 2);
    const start = Math.floor((r.x - offset) / sw) * sw + offset;
    for (let x = latticeFrom(start, sw, cull === null ? r.x : cull.x - sw); x < xEnd; x += sw) {
      const x0 = Math.max(r.x, x);
      const y0 = Math.max(r.y, y);
      const x1 = Math.min(r.x + r.w, x + sw - 1);
      const y1 = Math.min(r.y + r.h, y + sh - 1);
      if (x1 > x0 && y1 > y0) p.rect(x0, y0, x1 - x0, y1 - y0, hash2(x, y, 5) % 3 === 0 ? b : a);
    }
  }
};

/** The four strips of a ring between `outer` and `inner`: top, bottom, left, right. */
const ring = (outer: Box, inner: Box): readonly Box[] => [
  box(outer.x, outer.y, outer.w, inner.y - outer.y),
  box(outer.x, inner.y + inner.h, outer.w, outer.y + outer.h - inner.y - inner.h),
  box(outer.x, inner.y, inner.x - outer.x, inner.h),
  box(inner.x + inner.w, inner.y, outer.x + outer.w - inner.x - inner.w, inner.h),
];

const grow = (r: Box, by: number): Box => box(r.x - by, r.y - by, r.w + by * 2, r.h + by * 2);

/** One thing the garden draws, with every pixel it can touch. */
interface Op { readonly box: Box; readonly draw: (p: Painter, cull: Box | null) => void }

const fill = (r: Box, colour: string): Op => ({ box: r, draw: (p) => p.rect(r.x, r.y, r.w, r.h, colour) });

/** The street paths: stones with a kerb along each long side (top and bottom; left and right on the gate's path). */
const pathOps = (plan: Plan): readonly Op[] => plan.paths.map((path) => ({
  box: path,
  draw: (p, cull) => {
    stones(p, path, 12, 8, STONE.path, STONE.path2, STONE.pathEdge, cull);
    if (path === plan.gate) {
      p.rect(path.x, path.y, 2, path.h, STONE.kerb);
      p.rect(path.x + path.w - 2, path.y, 2, path.h, STONE.kerbDark);
      return;
    }
    p.rect(path.x, path.y, path.w, 2, STONE.kerb);
    p.rect(path.x, path.y + path.h - 2, path.w, 2, STONE.kerbDark);
  },
}));

const rimOps = (plan: Plan): readonly Op[] => {
  const { rim, building } = plan;
  return [
    ...ring(grow(rim, 2), grow(rim, 1)).map((s) => fill(s, STONE.kerbDark)),
    ...ring(grow(rim, 1), rim).map((s) => fill(s, STONE.kerb)),
    ...ring(rim, building).map((s): Op => ({ box: s, draw: (p, cull) => stones(p, s, 8, 8, STONE.a, STONE.b, STONE.joint, cull) })),
    fill(box(building.x + building.w, building.y + SHADOW.y, SHADOW.x, building.h), STONE.shadow),
    fill(box(building.x + SHADOW.x, building.y + building.h, building.w, SHADOW.y), STONE.shadow),
  ];
};

/** Lamps along every path (alternating sides), at the rim's corners, and along the rim's long sides. */
const lampSpots = (plan: Plan): readonly (readonly [number, number])[] => {
  const { rim, w, h, gate } = plan;
  const along = (path: Box, from: number, step: number): readonly (readonly [number, number])[] => {
    const spots: (readonly [number, number])[] = [];
    for (let i = 0, x = from; x > 8 && x < w - 8; i += 1, x += step) spots.push([x, i % 2 === 0 ? path.y + 6 : path.y + path.h - 6]);
    return spots;
  };
  const down = (path: Box): readonly (readonly [number, number])[] => {
    const spots: (readonly [number, number])[] = [];
    for (let i = 0, y = rim.y + rim.h + 30; y < h - 8; i += 1, y += 90) spots.push([i % 2 === 0 ? path.x + 6 : path.x + path.w - 6, y]);
    return spots;
  };
  const onGate = ([x]: readonly [number, number]): boolean => gate !== null && x > gate.x - 8 && x < gate.x + gate.w + 8;
  const corners = [[rim.x + 6, rim.y + 8], [rim.x + rim.w - 7, rim.y + 8], [rim.x + 6, rim.y + rim.h - 1], [rim.x + rim.w - 7, rim.y + rim.h - 1]] as const;
  const sides = [1, 2, 3].flatMap((k) => [[rim.x + Math.round((rim.w * k) / 4), rim.y + 8], [rim.x + Math.round((rim.w * k) / 4), rim.y + rim.h - 1]] as const)
    .filter((spot) => spot[1] !== rim.y + rim.h - 1 || !onGate(spot));
  return [
    ...plan.bands.flatMap(({ west, east }) => [...along(west, rim.x - 30, -90), ...along(east, rim.x + rim.w + 30, 90)]),
    ...(gate === null ? [] : down(gate)),
    ...corners, ...sides,
  ];
};

/** The beds and garden pieces, with a little room round them. */
const gardenPieces = (plan: Plan): readonly Box[] => {
  const { pond: pd, bench: bn, bikes } = plan;
  return [
    ...plan.beds.map((b) => box(b.x - 6, b.y - 6, b.w + 12, b.h + 12)),
    box(pd.cx - pd.rx - 12, pd.cy - pd.ry - 12, pd.rx * 2 + 24, pd.ry * 2 + 24),
    box(bn.x - 8, bn.y - 20, 44, 28), box(bikes.x - 8, bikes.y - 20, 50, 28),
  ];
};

/** Every pixel a bush round (x, y) of radius r can touch. */
const bushBox = (x: number, y: number, r: number): Box => box(x - r - 4, y - 2 * r - 4, 2 * r + 9, 3 * r + 10);

/**
 * Bushes in short rows along the outside of the rim, with gaps between the rows; none on a path or a garden piece:
 * the top and bottom rows step aside for the gate's path, the side columns for the bands' paths.
 */
const hedgeOps = (plan: Plan): readonly Op[] => {
  const { rim, gate } = plan;
  const pieces = gardenPieces(plan);
  const free = (x: number, y: number, r: number): boolean => {
    const at = box(x - r, y - r * 2, r * 2, r * 2 + 2);
    return !pieces.some((c) => overlaps(c, at)) && !(gate !== null && overlaps(grow(gate, 4), at));
  };
  const ops: Op[] = [];
  const bushAt = (x: number, y: number, r: number, flowers: string | null): void => {
    ops.push({ box: bushBox(x, y, r), draw: (p) => bush(p, x, y, r, flowers) });
  };
  for (let x = rim.x + 10, i = 0; x < rim.x + rim.w - 8; x += 22, i += 1) {
    if (i % 7 === 3 || i % 7 === 4) continue;
    const flowers = i % 5 === 1 ? '#b97a92' : i % 5 === 3 ? '#c9b46a' : null;
    const r = 7 + (hash2(i, 1, 9) % 2);
    if (free(x, rim.y - 4, r)) bushAt(x, rim.y - 4, r, null);
    if (free(x + 11, rim.y + rim.h + 15, r)) bushAt(x + 11, rim.y + rim.h + 15, r, flowers);
  }
  for (let y = rim.y + 20, i = 0; y < rim.y + rim.h - 10; y += 24, i += 1) {
    if (plan.bands.some(({ west }) => y > west.y - 22 && y < west.y + west.h + 18)) continue;
    bushAt(rim.x - 10, y, 7, null);
    bushAt(rim.x + rim.w + 10, y, 7, i % 3 === 0 ? '#8a7ac8' : null);
  }
  return ops;
};

/** The hedges reach this far out from the rim; past them two tiles of open lawn keep the building's outline clean. */
const HEDGE_DEPTH = 18;
export const LAWN_CLEAR = 2 * T;

const keepClearOf = (plan: Plan): readonly PixelRect[] => {
  const { rim } = plan;
  const reach = HEDGE_DEPTH + LAWN_CLEAR;
  return [
    box(rim.x - reach, rim.y - reach, rim.w + reach * 2, rim.h + reach * 2),
    ...plan.bands.flatMap(({ west, east }) => [west, east]).map((path) => box(path.x, path.y - 30, path.w, path.h + 50)),
    ...(plan.gate === null ? [] : [box(plan.gate.x - 25, plan.gate.y, plan.gate.w + 50, plan.gate.h)]),
    ...gardenPieces(plan),
  ];
};

/** Areas a tree must keep clear of: the rim, its hedges and two tiles of lawn, the paths and the garden pieces. */
export const treeKeepClear = (map: OfficeMap): readonly PixelRect[] => keepClearOf(planFor(map));

/** Every pixel a tree standing at (x, y) of radius r can touch: its crown, trunk and shadow. */
const treeBox = (x: number, y: number, r: number): Box => box(x - r - 4, y - 2 * r - 8, 2 * r + 10, 3 * r + 14);
/** Every pixel a lamp post standing at (x, y) can touch. */
const lampBox = (x: number, y: number): Box => box(x - 3, y - 24, 7, 26);

const piecesOps = (plan: Plan): readonly Op[] => {
  const { pond: pd, bench: bn, bikes } = plan;
  return [
    ...plan.beds.map((b, i): Op => ({ box: b, draw: (p) => flowerBed(p, b.x, b.y, b.w, b.h, i + 1) })),
    { box: box(pd.cx - pd.rx - 3, pd.cy - pd.ry - 3, pd.rx * 2 + 7, pd.ry * 2 + 7), draw: (p) => pond(p, pd.cx, pd.cy, pd.rx, pd.ry) },
    { box: box(bn.x, bn.y - 12, 30, 14), draw: (p) => bench(p, bn.x, bn.y) },
    { box: box(bikes.x, bikes.y - 10, 34, 11), draw: (p) => bikeRack(p, bikes.x, bikes.y) },
  ];
};

/** The garden's drawing, in order, bucketed by 512-px cell: a frame draws only the things of its cells. */
interface Garden {
  readonly plan: Plan;
  readonly ops: readonly Op[];
  readonly cells: ReadonlyMap<number, readonly number[]>;
  readonly cols: number;
  readonly lamps: readonly (readonly [number, number])[];
}

const cellRange = (b: Box, cols: number, rows: number): { readonly i0: number; readonly i1: number; readonly j0: number; readonly j1: number } => ({
  i0: Math.max(0, Math.floor(b.x / CELL)), i1: Math.min(cols - 1, Math.floor((b.x + b.w - 1) / CELL)),
  j0: Math.max(0, Math.floor(b.y / CELL)), j1: Math.min(rows - 1, Math.floor((b.y + b.h - 1) / CELL)),
});

const makeGarden = (plan: Plan): Garden => {
  const lamps = lampSpots(plan);
  const ops = [
    ...pathOps(plan), ...rimOps(plan), ...piecesOps(plan), ...hedgeOps(plan),
    ...treeSpots(plan.w, plan.h, keepClearOf(plan)).map((t): Op => ({ box: treeBox(t.x, t.y, t.r), draw: (p) => tree(p, t.x, t.y, t.r) })),
    ...lamps.map(([x, y]): Op => ({ box: lampBox(x, y), draw: (p) => lamp(p, x, y) })),
  ];
  const cols = Math.ceil(plan.w / CELL);
  const rows = Math.ceil(plan.h / CELL);
  const cells = new Map<number, number[]>();
  ops.forEach((op, k) => {
    const { i0, i1, j0, j1 } = cellRange(op.box, cols, rows);
    for (let j = j0; j <= j1; j += 1) {
      for (let i = i0; i <= i1; i += 1) {
        const list = cells.get(j * cols + i);
        if (list === undefined) cells.set(j * cols + i, [k]);
        else list.push(k);
      }
    }
  });
  return { plan, ops, cells, cols, lamps };
};

const GARDENS = new WeakMap<Plan, Garden>();
const gardenFor = (map: OfficeMap): Garden => {
  const plan = planFor(map);
  const known = GARDENS.get(plan);
  if (known !== undefined) return known;
  const made = makeGarden(plan);
  GARDENS.set(plan, made);
  return made;
};

/** The garden's things that meet a frame, in drawing order: from the cells it covers (one cell for a chunk). */
const opsMeeting = (garden: Garden, cull: Box): readonly Op[] => {
  const rows = Math.ceil(garden.plan.h / CELL);
  const { i0, i1, j0, j1 } = cellRange(cull, garden.cols, rows);
  const picked = new Set<number>();
  for (let j = j0; j <= j1; j += 1) for (let i = i0; i <= i1; i += 1) (garden.cells.get(j * garden.cols + i) ?? []).forEach((k) => picked.add(k));
  return [...picked].toSorted((a, b) => a - b).flatMap((k) => {
    const op = garden.ops[k];
    return op !== undefined && overlaps(op.box, cull) ? [op] : [];
  });
};

/**
 * Paints the garden in exterior pixels: the paths, the paved rim with the building's shadow, beds, pond, bench and
 * bike rack, hedges, trees and lamps, in that order. With `cull`, only the things that meet it; the pixels inside
 * `cull` are the same either way. The lamps' pools of light are added afterwards (withLampLight).
 */
export function drawExterior(p: Painter, map: OfficeMap, cull?: PixelRect): void {
  const garden = gardenFor(map);
  (cull === undefined ? garden.ops : opsMeeting(garden, cull)).forEach((op) => op.draw(p, cull ?? null));
}

let ground: Raster | null = null;
const grass = (): Raster => {
  ground ??= groundRaster();
  return ground;
};

/**
 * The building's surroundings at dusk, as one picture EXTERIOR_MARGIN larger than the map on every side: a paved rim
 * round the walls with the building's drop shadow on it, stone paths from every street door to the picture's edge,
 * lamps, hedges, trees, flower beds, a bench, a bike rack and a pond. Transparent where the grass (groundRaster,
 * repeated by the scene) shows, and over the building itself. Deterministic: the same map always gives the same
 * pixels. Full size: the oracle of the exterior chunks (the scene paints chunks, see chunkRaster).
 */
export function exteriorRaster(map: OfficeMap): Raster {
  const garden = gardenFor(map);
  const picture = paint(garden.plan.w, garden.plan.h, (p) => drawExterior(p, map));
  return withLampLight(picture, grass(), garden.lamps, garden.plan.building);
}

/**
 * The garden over a frame given in exterior pixels (a chunk, cropped to the picture): its things and the lamp light of
 * the lamps whose pools meet it, the grass read at the garden's own coordinates. Never larger than the frame.
 */
export function exteriorFrame(map: OfficeMap, frame: PixelRect): Raster {
  const garden = gardenFor(map);
  const picture = paintWindow(frame, (p) => drawExterior(p, map, frame));
  const lit = garden.lamps.filter(([x, y]) => overlaps(poolBox(x, y), frame));
  return withLampLight(picture, grass(), lit, garden.plan.building, frame);
}

/** Where the lamps stand (their feet), in exterior pixels. */
export function lampFeet(map: OfficeMap): readonly (readonly [number, number])[] {
  return gardenFor(map).lamps;
}

/** The garden's paths and its pieces (beds, pond, bench, bike rack), in exterior pixels: what must never meet. */
export function gardenLayout(map: OfficeMap): { readonly paths: readonly PixelRect[]; readonly pieces: readonly PixelRect[] } {
  const plan = planFor(map);
  const { pond: pd, bench: bn, bikes } = plan;
  return {
    paths: plan.paths,
    pieces: [...plan.beds, box(pd.cx - pd.rx - 3, pd.cy - pd.ry - 3, pd.rx * 2 + 7, pd.ry * 2 + 7), box(bn.x, bn.y - 12, 30, 14), box(bikes.x, bikes.y - 10, 34, 11)],
  };
}

/** Where the exterior picture goes in map pixels: its top-left corner. */
export const EXTERIOR_ORIGIN = Object.freeze({ x: -EXTERIOR_MARGIN, y: -EXTERIOR_MARGIN });
