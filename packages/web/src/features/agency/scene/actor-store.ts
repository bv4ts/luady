import {
  TILE, findPath, walkMask,
  type ActorView, type AgencySnapshot, type OfficeMap, type PixelPoint, type TilePoint, type WalkMask,
} from '@luady/office';
import { LUADY_ACTOR_ID } from '../stage-types.js';
import { WALK_SPEED, stepWalk, type Walk } from './motion.js';
import { diffActors, type ActorChange } from './reconcile.js';

/** One character on the map: where it is now and where it is going. Every update makes a new object. */
export interface StageActor {
  readonly id: string;
  /** The session it draws; null for Luady, who is not a session. */
  readonly view: ActorView | null;
  readonly pos: PixelPoint;
  readonly walk: Walk | null;
  /** Next point of `walk` to reach. */
  readonly index: number;
  /** Walking out; removed when it reaches the door. */
  readonly leaving: boolean;
  /** Milliseconds before it steps in through the door; it is not drawn until then. */
  readonly wait: number;
}

/** Positions and walks of every character, with no drawing (the Pixi layer reads it each frame). */
export interface ActorStore {
  /**
   * Brings the cast in line with a snapshot and returns what changed. The first snapshot seats everyone at once, and
   * so does one applied with `settle` (the first built from loaded data, or after a reload of the overview). A
   * snapshot of another layout (its map's layoutKey changed: rooms added, moved or removed) puts everyone straight at
   * their seat and drops the leavers, so nobody walks on the old layout's coordinates.
   */
  apply(snapshot: AgencySnapshot, options?: { readonly settle?: boolean }): readonly ActorChange[];
  /** Advances every walk. True when anything moved or left. */
  step(dtMs: number): boolean;
  list(): readonly StageActor[];
  get(id: string): StageActor | undefined;
  /** On: nobody walks; walks in progress end at once. */
  setReducedMotion(on: boolean): void;
}

/** Walkers stand this far below a tile centre. */
const FEET = 5;
/** Sessions arriving together (one update, or updates in quick succession) come through a door at least this far apart. */
export const ARRIVAL_GAP_MS = 200;

const point = (x: number, y: number): PixelPoint => Object.freeze({ x, y });
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
/** The map tile under a point, kept on the map (its size comes from the snapshot). */
const tileOf = (p: PixelPoint, map: OfficeMap): TilePoint =>
  Object.freeze({
    tx: clamp(Math.floor(p.x / TILE), 0, Math.ceil(map.width / TILE) - 1),
    ty: clamp(Math.floor((p.y - FEET) / TILE), 0, Math.ceil(map.height / TILE) - 1),
  });
const standAt = (t: TilePoint): PixelPoint => point(t.tx * TILE + TILE / 2, t.ty * TILE + TILE / 2 + FEET);

const seatTile = (snapshot: AgencySnapshot, a: ActorView): TilePoint => snapshot.slots[a.room]?.[a.seat]?.tile ?? tileOf(a.sit, snapshot.map);

/** The street door nearest a tile (Manhattan distance; the first listed wins a tie), from every door of the map. */
export const doorFor = (snapshot: AgencySnapshot, t: TilePoint): TilePoint => {
  const { entries, luadyHome } = snapshot.map.spots;
  let best: TilePoint = entries[0] ?? luadyHome;
  let far = Number.POSITIVE_INFINITY;
  entries.forEach((door) => {
    const d = Math.abs(t.tx - door.tx) + Math.abs(t.ty - door.ty);
    if (d < far) {
      far = d;
      best = door;
    }
  });
  return best;
};

const route = (s: AgencySnapshot, grid: WalkMask, from: PixelPoint, to: TilePoint, end: PixelPoint): Walk =>
  Object.freeze({ points: Object.freeze([...findPath(grid, tileOf(from, s.map), to).map((p) => point(p.x, p.y + FEET)), end]), speed: WALK_SPEED });

const actor = (id: string, view: ActorView | null, pos: PixelPoint, walk: Walk | null = null, leaving = false, wait = 0): StageActor =>
  Object.freeze({ id, view, pos, walk, index: 0, leaving, wait });

/** One walker after `dtMs`: a waiting arrival first uses up its wait, then walks with the time that is left. */
const advance = (a: StageActor, walk: Walk, dtMs: number): { readonly next: StageActor; readonly done: boolean; readonly moved: boolean } => {
  if (a.wait > dtMs) return { next: Object.freeze({ ...a, wait: a.wait - dtMs }), done: false, moved: false };
  const step = stepWalk(a.pos, walk, a.index, dtMs - a.wait);
  const moved = a.wait > 0 || step.pos.x !== a.pos.x || step.pos.y !== a.pos.y;
  const next = step.done ? actor(a.id, a.view, step.pos) : Object.freeze({ ...a, pos: step.pos, index: step.index, wait: 0 });
  return { next, done: step.done, moved };
};

export function createActorStore(options: { readonly reducedMotion?: boolean } = {}): ActorStore {
  const cast = new Map<string, StageActor>();
  const grids = new WeakMap<AgencySnapshot, WalkMask>();
  let previous: AgencySnapshot | null = null;
  let reduced = options.reducedMotion === true;
  /** Milliseconds walked so far (the sum of every step), and when the last arrival stepped in at each street door. */
  let clock = 0;
  const doorFreeAt = new Map<string, number>();

  const gridOf = (s: AgencySnapshot): WalkMask => {
    const known = grids.get(s);
    if (known !== undefined) return known;
    const grid = walkMask(s.map, s.slots, s.props);
    grids.set(s, grid);
    return grid;
  };

  /** A new layout: everyone of the snapshot at their seat, nobody else, no walks and no queue at the doors. */
  const reseat = (s: AgencySnapshot): void => {
    cast.forEach((_, id) => { if (!Object.hasOwn(s.actors, id)) cast.delete(id); });
    Object.values(s.actors).forEach((view) => cast.set(view.id, actor(view.id, view, view.sit)));
    doorFreeAt.clear();
  };

  /** Sends a character to its seat in `s`, or puts it there at once. */
  const toSeat = (s: AgencySnapshot, view: ActorView, from: PixelPoint | null): StageActor => {
    if (reduced || from === null) return actor(view.id, view, view.sit);
    return actor(view.id, view, from, route(s, gridOf(s), from, seatTile(s, view), view.sit));
  };

  const enter = (s: AgencySnapshot, view: ActorView, first: boolean): StageActor => {
    const here = cast.get(view.id);
    if (here !== undefined) return toSeat(s, view, here.pos);
    if (first || reduced) return toSeat(s, view, null);
    const door = doorFor(s, seatTile(s, view));
    const walker = toSeat(s, view, standAt(door));
    const key = `${door.tx},${door.ty}`;
    const start = Math.max(clock, (doorFreeAt.get(key) ?? Number.NEGATIVE_INFINITY) + ARRIVAL_GAP_MS);
    doorFreeAt.set(key, start);
    return start === clock ? walker : Object.freeze({ ...walker, wait: start - clock });
  };

  const leave = (s: AgencySnapshot, id: string): void => {
    const here = cast.get(id);
    if (here === undefined) return;
    if (reduced || here.wait > 0) {
      cast.delete(id);
      return;
    }
    const door = doorFor(s, tileOf(here.pos, s.map));
    cast.set(id, actor(id, here.view, here.pos, route(s, gridOf(s), here.pos, door, standAt(door)), true));
  };

  const applyChange = (s: AgencySnapshot, change: ActorChange, first: boolean): void => {
    if (change.kind === 'leave') leave(s, change.id);
    else if (change.kind === 'enter') cast.set(change.actor.id, enter(s, change.actor, first));
    else if (change.kind === 'move') cast.set(change.actor.id, toSeat(s, change.actor, cast.get(change.actor.id)?.pos ?? null));
    else {
      const here = cast.get(change.actor.id);
      cast.set(change.actor.id, here === undefined ? toSeat(s, change.actor, null) : Object.freeze({ ...here, view: change.actor }));
    }
  };

  /** Keeps the newest facts of everyone still on the map (names, questions) without disturbing their walks. */
  const refresh = (s: AgencySnapshot): void => {
    Object.values(s.actors).forEach((view) => {
      const here = cast.get(view.id);
      if (here !== undefined && here.view !== view && !here.leaving) cast.set(view.id, Object.freeze({ ...here, view }));
    });
    const luady = s.map.spots.luadySit;
    const here = cast.get(LUADY_ACTOR_ID);
    if (here === undefined || here.pos.x !== luady.x || here.pos.y !== luady.y) cast.set(LUADY_ACTOR_ID, actor(LUADY_ACTOR_ID, null, luady));
  };

  const finishAll = (): void => {
    cast.forEach((a, id) => {
      if (a.walk === null) return;
      if (a.leaving) cast.delete(id);
      else cast.set(id, actor(id, a.view, a.walk.points.at(-1) ?? a.pos));
    });
  };

  return {
    apply: (snapshot, options) => {
      const changes = diffActors(previous, snapshot);
      const relaid = previous !== null && previous.map.layoutKey !== snapshot.map.layoutKey;
      const settle = previous === null || options?.settle === true;
      if (relaid) reseat(snapshot);
      else changes.forEach((c) => applyChange(snapshot, c, settle));
      refresh(snapshot);
      previous = snapshot;
      return changes;
    },
    step: (dtMs) => {
      let changed = false;
      if (Number.isFinite(dtMs) && dtMs > 0) clock += dtMs;
      cast.forEach((a, id) => {
        if (a.walk === null) return;
        const { next, done, moved } = advance(a, a.walk, Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0);
        changed = changed || done || moved;
        if (done && a.leaving) cast.delete(id);
        else cast.set(id, next);
      });
      return changed;
    },
    list: () => [...cast.values()],
    get: (id) => cast.get(id),
    setReducedMotion: (on) => {
      reduced = on;
      if (on) finishAll();
    },
  };
}
