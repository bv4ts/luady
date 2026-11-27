import type { PixelPoint, TilePoint } from '../src/types.js';
import type { WalkGrid } from '../src/walk.js';

export const centre = (t: TilePoint): PixelPoint => ({ x: t.tx * 16 + 8, y: t.ty * 16 + 8 });
export const tileOf = (p: PixelPoint): TilePoint => ({ tx: (p.x - 8) / 16, ty: (p.y - 8) / 16 });
export const open = (grid: WalkGrid, t: TilePoint): boolean => grid[t.ty]?.[t.tx] === true;

/** Walks the path tile by tile from the start: proves every step is straight, one tile at a time, and on open floor (the goal may be blocked). */
export const walkable = (grid: WalkGrid, from: TilePoint, path: readonly PixelPoint[]): boolean => {
  let at = centre(from);
  return path.every((point, i) => {
    if (at.x !== point.x && at.y !== point.y) return false;
    const a = tileOf(at);
    const b = tileOf(point);
    const steps = Math.abs(b.tx - a.tx) + Math.abs(b.ty - a.ty);
    const tiles = Array.from({ length: steps }, (_, k) => ({ tx: a.tx + Math.sign(b.tx - a.tx) * (k + 1), ty: a.ty + Math.sign(b.ty - a.ty) * (k + 1) }));
    at = point;
    const last = i === path.length - 1;
    return tiles.every((t, k) => open(grid, t) || (last && k === tiles.length - 1));
  });
};
