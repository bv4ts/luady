import type { PixelPoint } from '@luady/office';

/** A route to follow: corner points in world pixels, walked in order at `speed` pixels per millisecond. */
export interface Walk { readonly points: readonly PixelPoint[]; readonly speed: number }

export interface WalkStep { readonly pos: PixelPoint; readonly index: number; readonly done: boolean }

/** Pixels per millisecond: a walker moves at 66 px/s. */
export const WALK_SPEED = 0.066;

const point = (x: number, y: number): PixelPoint => Object.freeze({ x, y });

/**
 * Moves `pos` along `walk` from point `index` for `dtMs`. Corners are turned within one step; the last point is
 * reached exactly and never passed. An empty route, or an index past the end, is done at once.
 */
export function stepWalk(pos: PixelPoint, walk: Walk, index: number, dtMs: number): WalkStep {
  let budget = Number.isFinite(dtMs) && dtMs > 0 ? dtMs * walk.speed : 0;
  let at = pos;
  let i = Math.max(0, index);
  while (i < walk.points.length) {
    const target = walk.points[i];
    if (target === undefined) break;
    const dx = target.x - at.x;
    const dy = target.y - at.y;
    const dist = Math.hypot(dx, dy);
    if (dist > budget) {
      const k = budget / dist;
      return Object.freeze({ pos: point(at.x + dx * k, at.y + dy * k), index: i, done: false });
    }
    budget -= dist;
    at = point(target.x, target.y);
    i += 1;
  }
  return Object.freeze({ pos: at, index: i, done: true });
}
