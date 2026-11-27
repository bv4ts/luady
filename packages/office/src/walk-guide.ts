/**
 * What findPath may know about a walk grid it was handed: which tiles belong to a room (a pocket with a single door).
 * A shortest walk never enters a room that holds neither of its ends, since it would leave by the door it came in by,
 * so the search skips those rooms. walk.ts registers a guide for every mask and grid it makes; any other grid is
 * searched plainly. Internal: not part of the package's barrel.
 */
export interface WalkGuide {
  /** The room (pocket) a tile belongs to, or -1 for halls, HQ and everything else. */
  readonly pocketOf: (tx: number, ty: number) => number;
}

const GUIDES = new WeakMap<object, WalkGuide>();

export function guide(grid: object, how: WalkGuide): void {
  GUIDES.set(grid, how);
}

export function guideOf(grid: object): WalkGuide | undefined {
  return GUIDES.get(grid);
}
