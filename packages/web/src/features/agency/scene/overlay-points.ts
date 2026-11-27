import { HQ_ID, TILE, roomRectPx, type AgencySnapshot, type PixelRect } from '@luady/office';
import type { OverlayPoint } from '../stage-types.js';
import type { ActorBody } from './actors.js';
import { FAR_BADGES, contains, overlaps, type LiveView } from './live-set.js';

/** What the overlay points need of the camera: map → stage CSS pixels, the stage size, the zoom and the lit area. */
export interface ScreenView {
  toScreen(x: number, y: number): { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
  /** CSS pixels per map pixel. */
  readonly scale: number;
  /** The area that is not dimmed, or null when nothing is. */
  readonly bright: PixelRect | null;
}

/** Desks stand four tiles apart in both arrangements: a plate centred on its sitter stays inside that span. */
const DESK_PITCH = 4 * TILE;
/** CSS pixels kept free between two neighbouring plates. */
const PLATE_GAP = 6;

const lit = (view: ScreenView, x: number, y: number): boolean => {
  const b = view.bright;
  return b === null || (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
};
const onStage = (view: ScreenView, x: number, y: number): boolean => x >= 0 && y >= 0 && x <= view.width && y <= view.height;

/** Each character's head top and plate start; hidden outside the stage or in a dimmed room. */
const actorPoints = (bodies: readonly ActorBody[], view: ScreenView): readonly OverlayPoint[] => {
  const maxWidth = Math.max(0, DESK_PITCH * view.scale - PLATE_GAP);
  return bodies.map((b) => {
    const p = view.toScreen(b.x, b.top);
    const foot = view.toScreen(b.x, b.base);
    const inStage = p.x >= 0 && foot.y >= 0 && p.x <= view.width && p.y <= view.height;
    return Object.freeze({ kind: 'actor' as const, id: b.id, x: p.x, y: p.y, footY: foot.y, maxWidth, visible: inStage && lit(view, b.x, b.y), scale: view.scale });
  });
};

/** The fixtures the scene draws: those of the live view's rooms and the street ones in reach; none in far mode. */
const liveFixtures = (snapshot: AgencySnapshot, live: LiveView | null): AgencySnapshot['fixtures'] => {
  if (live === null) return snapshot.fixtures;
  if (live.far) return [];
  return snapshot.fixtures.filter((f) => live.rooms.has(f.room) || (!Object.hasOwn(snapshot.map.rooms, f.room) && contains(live.reach, f.anchor.x, f.anchor.y)));
};

/** Each fixture's anchor (top-centre of its picture), for its badge; `maxWidth` is its picture's width on screen. */
const fixturePoints = (snapshot: AgencySnapshot, view: ScreenView, live: LiveView | null): readonly OverlayPoint[] =>
  liveFixtures(snapshot, live).map((f) => {
    const p = view.toScreen(f.anchor.x, f.anchor.y);
    const visible = onStage(view, p.x, p.y) && lit(view, f.anchor.x, f.anchor.y + 1);
    return Object.freeze({ kind: 'fixture' as const, id: f.id, x: p.x, y: p.y, footY: p.y, maxWidth: f.box.w * view.scale, visible, scale: view.scale });
  });

/**
 * The rooms that get a point: every room before the first view; then the live rooms and HQ when in reach, and in far
 * mode the FAR_BADGES live rooms nearest the view centre (the HUD's badges).
 */
const pointedRooms = (snapshot: AgencySnapshot, live: LiveView | null): ReadonlySet<string> | null => {
  if (live === null) return null;
  const hq = snapshot.map.rooms[HQ_ID];
  const withHq = hq !== undefined && overlaps(live.reach, roomRectPx(hq)) ? [HQ_ID] : [];
  if (!live.far) return new Set([...live.live.map((r) => r.id), ...withHq]);
  const near = live.live.map((r) => {
    const q = roomRectPx(r);
    return { id: r.id, d: Math.hypot(q.x + q.w / 2 - live.centre.x, q.y + q.h / 2 - live.centre.y) };
  }).sort((a, b) => a.d - b.d).slice(0, FAR_BADGES);
  return new Set([...near.map((r) => r.id), ...withHq]);
};

/**
 * Each room's top-left inside corner (inside the side wall, below the back wall), for its plaque; `maxWidth` is the
 * room's inside width.
 */
const roomPoints = (snapshot: AgencySnapshot, view: ScreenView, live: LiveView | null): readonly OverlayPoint[] => {
  const wanted = pointedRooms(snapshot, live);
  const keys = wanted === null ? snapshot.map.order : snapshot.map.order.filter((key) => wanted.has(key));
  return keys.flatMap((key) => {
    const room = snapshot.map.rooms[key];
    if (room === undefined) return [];
    const q = roomRectPx(room);
    const corner = { x: q.x + TILE, y: q.y + TILE * 2 };
    const p = view.toScreen(corner.x, corner.y);
    const visible = onStage(view, p.x, p.y) && lit(view, corner.x, corner.y);
    return [Object.freeze({ kind: 'room' as const, id: key, x: p.x, y: p.y, footY: p.y, maxWidth: (q.w - TILE * 2) * view.scale, visible, scale: view.scale })];
  });
};

/**
 * Every overlay point of a frame: characters, then fixtures, then rooms. Only what the scene draws for
 * `live` (the characters in `bodies` are already only those shown); everything before the first view.
 */
export function overlayPoints(snapshot: AgencySnapshot, bodies: readonly ActorBody[], view: ScreenView, live: LiveView | null = null): readonly OverlayPoint[] {
  return Object.freeze([...actorPoints(bodies, view), ...fixturePoints(snapshot, view, live), ...roomPoints(snapshot, view, live)]);
}
