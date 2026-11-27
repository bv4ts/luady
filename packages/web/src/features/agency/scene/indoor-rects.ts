import type { PixelRect } from '@luady/office';

/**
 * The union of disjoint, axis-aligned rectangles as few disjoint rectangles: the daytime tint covers `zones.indoor`
 * (rooms, HQ, streets and the avenue; not the courts), which at 300 rooms is about 350 rectangles, so it is drawn as
 * its merged area instead, a handful of sprites at any size. Bands between consecutive y edges are cut into x runs;
 * equal runs of neighbouring bands are joined. Pure.
 */
export function mergeRects(rects: readonly PixelRect[]): readonly PixelRect[] {
  const solid = rects.filter((r) => r.w > 0 && r.h > 0);
  const ys = [...new Set(solid.flatMap((r) => [r.y, r.y + r.h]))].sort((a, b) => a - b);
  const out: PixelRect[] = [];
  let open = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (let k = 0; k + 1 < ys.length; k += 1) {
    const y0 = ys[k] ?? 0;
    const y1 = ys[k + 1] ?? y0;
    const spans = solid.filter((r) => r.y <= y0 && r.y + r.h >= y1).map((r) => [r.x, r.x + r.w] as const).sort((a, b) => a[0] - b[0]);
    const runs: [number, number][] = [];
    spans.forEach(([a, b]) => {
      const last = runs.at(-1);
      if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
      else runs.push([a, b]);
    });
    const next = new Map<string, { x: number; y: number; w: number; h: number }>();
    runs.forEach(([a, b]) => {
      const key = `${a},${b}`;
      const grown = open.get(key);
      if (grown !== undefined && grown.y + grown.h === y0) {
        grown.h = y1 - grown.y;
        next.set(key, grown);
        open.delete(key);
      } else {
        next.set(key, { x: a, y: y0, w: b - a, h: y1 - y0 });
      }
    });
    open.forEach((r) => out.push(Object.freeze({ ...r })));
    open = next;
  }
  open.forEach((r) => out.push(Object.freeze({ ...r })));
  return Object.freeze(out.sort((a, b) => a.y - b.y || a.x - b.x));
}
