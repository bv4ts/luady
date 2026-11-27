import { hash2 } from './ground.js';

/** Where the trees of the garden stand: a few groves with open lawn between them, and a few lone trees. */

export interface Area { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface TreeSpot { readonly x: number; readonly y: number; readonly r: number }

/** Grove centres are picked from a coarse grid: two cells in GROVE_ODDS (three) hold a grove, the third is open lawn. */
const GROVE_CELL = 260;
const GROVE_ODDS = 3;
/** Trees per grove grow with its size; tries per tree, since many land too close to another or on a path. */
const TREES_PER_GROVE = { min: 6, max: 15 } as const;
const TRIES = 4;
const LONE_CELL = 170;
const LONE_ODDS = 3;

const overlaps = (a: Area, b: Area): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** What a tree covers: its crown above the trunk and its shadow at the foot. */
export const treeArea = (t: TreeSpot): Area => ({ x: t.x - t.r - 2, y: t.y - 8 - t.r * 2 - 2, w: t.r * 2 + 8, h: t.r * 2 + 14 });

/** Trunks stand at least this far apart, so crowns overlap a little but never merge into one blob. */
const tooClose = (a: TreeSpot, b: TreeSpot): boolean => {
  const gap = (a.r + b.r) * 0.8;
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 < gap * gap;
};

/** Candidates of one grove: a jittered centre, then trees spread round it, the biggest near the middle. */
const groveCandidates = (cx: number, cy: number, seed: number): readonly TreeSpot[] => {
  const spread = 50 + (seed % 70);
  const count = TREES_PER_GROVE.min + (seed % (TREES_PER_GROVE.max - TREES_PER_GROVE.min + 1));
  return Array.from({ length: count * TRIES }, (_, i) => {
    const a = (hash2(seed, i, 21) % 6283) / 1000;
    const d = Math.sqrt((hash2(seed, i, 22) % 1000) / 1000) * spread;
    const near = 1 - d / spread;
    const r = 7 + Math.round(near * 6) + (hash2(seed, i, 23) % 5);
    return { x: Math.round(cx + Math.cos(a) * d * 1.3), y: Math.round(cy + Math.sin(a) * d * 0.8), r };
  });
};

const groves = (w: number, h: number): readonly TreeSpot[] => {
  const spots: TreeSpot[] = [];
  for (let gy = 0; gy < h; gy += GROVE_CELL) {
    for (let gx = 0; gx < w; gx += GROVE_CELL) {
      const seed = hash2(gx, gy, 20);
      if (seed % GROVE_ODDS === 0) continue;
      spots.push(...groveCandidates(gx + 40 + ((seed >>> 4) % (GROVE_CELL - 80)), gy + 40 + ((seed >>> 12) % (GROVE_CELL - 80)), seed));
    }
  }
  return spots;
};

const loners = (w: number, h: number): readonly TreeSpot[] => {
  const spots: TreeSpot[] = [];
  for (let gy = 0; gy < h; gy += LONE_CELL) {
    for (let gx = 0; gx < w; gx += LONE_CELL) {
      const seed = hash2(gx, gy, 30);
      if (seed % LONE_ODDS !== 0) continue;
      spots.push({ x: gx + (seed >>> 4) % LONE_CELL, y: gy + (seed >>> 12) % LONE_CELL, r: 8 + (seed % 9) });
    }
  }
  return spots;
};


/**
 * The garden's trees inside a `w × h` picture, kept clear of `keepClear` and of each other, sorted back to front.
 * Deterministic: the same size and areas always give the same trees. Candidates are tried in a fixed order;
 * the "too close to a placed tree" test looks only at the placed trees of the neighbouring cells of a grid whose cells
 * are as large as the widest gap two trees can need, so the work is linear in the candidates.
 */
export function treeSpots(w: number, h: number, keepClear: readonly Area[]): readonly TreeSpot[] {
  const candidates = [...groves(w, h), ...loners(w, h)];
  const widest = candidates.reduce((most, t) => Math.max(most, t.r), 0);
  const cell = Math.max(1, Math.ceil(widest * 2 * 0.8));
  const stride = Math.ceil(h / cell) + 4;
  const cells = new Map<number, TreeSpot[]>();
  const keyOf = (cx: number, cy: number): number => (cx + 2) * stride + (cy + 2);
  const placed: TreeSpot[] = [];
  candidates.forEach((t) => {
    const area = treeArea(t);
    if (area.x < -t.r || area.y < -t.r * 2 || area.x + area.w > w + t.r || area.y > h) return;
    if (keepClear.some((c) => overlaps(c, area))) return;
    const cx = Math.floor(t.x / cell);
    const cy = Math.floor(t.y / cell);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const o of cells.get(keyOf(cx + dx, cy + dy)) ?? []) {
          if (tooClose(o, t)) return;
        }
      }
    }
    placed.push(t);
    const key = keyOf(cx, cy);
    const list = cells.get(key);
    if (list === undefined) cells.set(key, [t]);
    else list.push(t);
  });
  return placed.toSorted((a, b) => a.y - b.y || a.x - b.x);
}
