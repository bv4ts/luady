import { BAND_H, HQ_ID, ROOM_W, TILE, roomRectPx, type AgencySnapshot, type OfficeMap, type PixelPoint, type PixelRect } from '@luady/office';
import { LUADY_ACTOR_ID, type StageFocus, type StageInsets } from '../stage-types.js';
import { FAR_SCALE } from './live-set.js';

export interface ViewSize { readonly width: number; readonly height: number }
/** A camera aim: zoom, and the world point that sits at the centre of the free area. */
export interface CameraFit { readonly scale: number; readonly x: number; readonly y: number }

/** Tiles around an actor's seat when the camera follows one actor. */
const ACTOR_VIEW = { w: 12 * TILE, h: 8 * TILE } as const;
/** Characters are drawn above their feet: centre the actor view on the body, not the feet. */
const BODY_LIFT = 8;
/** Free width ÷ free height from which the whole building is fitted; below it the office opens at full height. */
export const WIDE_RATIO = 1.25;
/** One room's width in pixels: the narrow-screen opening shows at least this much across. */
export const ONE_ROOM_W = ROOM_W * TILE;
/** One band of the building (two rows of rooms and their street) in pixels: HQ's height. */
export const BAND_PX = BAND_H * TILE;
/** Below this whole-office fit a wide screen opens on HQ's row instead. */
export const OVERVIEW_MIN = 0.45;
/** How far past the building the owner may pan, in map pixels. */
export const PAN_MARGIN = 64;
/** The closest zoom the owner can reach. */
export const MAX_ZOOM = 4;
/**
 * The farthest a room or actor focus zooms out: the far-mode zoom, so a focused room is always drawn in detail and can be
 * tapped, even where the free area cannot hold it whole (a phone with the room sheet open over half the screen).
 */
export const FOCUS_MIN = FAR_SCALE;

const rect = (x: number, y: number, w: number, h: number): PixelRect => Object.freeze({ x, y, w, h });
const point = (x: number, y: number): PixelPoint => Object.freeze({ x, y });

/** The stage area not covered by the top bar, chat line or a panel, at least one pixel each way. */
export function freeSize(view: ViewSize, insets: StageInsets): ViewSize {
  return {
    width: Math.max(1, view.width - insets.left - insets.right),
    height: Math.max(1, view.height - insets.top - insets.bottom),
  };
}

/**
 * The largest zoom (up to `maxScale`) at which `r` fits the free area, not rounded: crisp pixels at a fractional zoom
 * come from the renderer's resolution (see pixel-density.ts). `x, y` is the rectangle's centre, to be placed at the
 * centre of the free area.
 */
export function fitRect(r: PixelRect, view: ViewSize, insets: StageInsets, maxScale: number): CameraFit {
  const free = freeSize(view, insets);
  const scale = Math.min(free.width / Math.max(1, r.w), free.height / Math.max(1, r.h), maxScale);
  return Object.freeze({ scale, x: r.x + r.w / 2, y: r.y + r.h / 2 });
}

/** The zoom at which the whole building fits the free area: the farthest the owner can zoom out. */
export function fitZoom(map: OfficeMap, view: ViewSize, insets: StageInsets): number {
  return Math.min(fitRect(map.zones.all, view, insets, Number.POSITIVE_INFINITY).scale, MAX_ZOOM);
}

/**
 * The whole-office view. On a wide free area (width ÷ height ≥ 1.25)
 * the building is fitted while that fit is at least OVERVIEW_MIN; a bigger building opens on HQ's row at up to
 * OVERVIEW_MIN, the whole building one pinch away. On a narrow area it opens one band high and one room wide, centred
 * on HQ, whatever the number of rooms. Never farther out than the fit. With one band (up to 24 rooms on a laptop, the
 * classic four everywhere) the band is the building's height.
 */
export function wholeOfficeFit(map: OfficeMap, view: ViewSize, insets: StageInsets): CameraFit {
  const free = freeSize(view, insets);
  const all = map.zones.all;
  const fit = fitZoom(map, view, insets);
  const hq = map.zones.hq;
  const row = map.zones.hqRow;
  const onHqRow = (scale: number): CameraFit => Object.freeze({ scale, x: hq.x + hq.w / 2, y: row.y + row.h / 2 });
  if (free.width / free.height >= WIDE_RATIO) {
    if (fit >= OVERVIEW_MIN) return Object.freeze({ scale: fit, x: all.x + all.w / 2, y: all.y + all.h / 2 });
    return onHqRow(Math.max(fit, Math.min(OVERVIEW_MIN, free.height / BAND_PX)));
  }
  return onHqRow(Math.max(fit, Math.min(free.height / BAND_PX, free.width / ONE_ROOM_W, MAX_ZOOM)));
}

/** The world point at the centre of the whole stage when `fit` puts its point at the centre of the free area. */
export function viewCenter(fit: CameraFit, insets: StageInsets): PixelPoint {
  return point(fit.x + (insets.right - insets.left) / 2 / fit.scale, fit.y + (insets.bottom - insets.top) / 2 / fit.scale);
}

/** A room with a one-tile margin; HQ is the whole HQ room (its wall fixtures stay clear of the top bar). */
const roomRect = (snapshot: AgencySnapshot, key: string): PixelRect | null => {
  const room = Object.hasOwn(snapshot.map.rooms, key) ? snapshot.map.rooms[key] : undefined;
  if (room === undefined) return null;
  const q = key === HQ_ID ? snapshot.map.zones.hq : roomRectPx(room);
  return rect(q.x - TILE, q.y - TILE, q.w + TILE * 2, q.h + TILE * 2);
};

const aroundSeat = (sit: PixelPoint): PixelRect => rect(sit.x - ACTOR_VIEW.w / 2, sit.y - BODY_LIFT - ACTOR_VIEW.h / 2, ACTOR_VIEW.w, ACTOR_VIEW.h);

/**
 * What the camera frames: the whole building; a room with a one-tile margin (HQ: the whole HQ room); or 12 × 8 tiles
 * around an actor's seat. An actor that is gone falls back to `lastRoom`, else to the whole office.
 */
export function focusRect(snapshot: AgencySnapshot, focus: StageFocus, lastRoom: string | null = null): PixelRect {
  if (focus.kind === 'room') return roomRect(snapshot, focus.room) ?? snapshot.map.zones.all;
  if (focus.kind === 'actor') {
    if (focus.id === LUADY_ACTOR_ID) return aroundSeat(snapshot.map.spots.luadySit);
    const actor = Object.hasOwn(snapshot.actors, focus.id) ? snapshot.actors[focus.id] : undefined;
    if (actor !== undefined) return aroundSeat(actor.sit);
    return (lastRoom === null ? null : roomRect(snapshot, lastRoom)) ?? snapshot.map.zones.all;
  }
  return snapshot.map.zones.all;
}

/** The room the camera keeps bright for a focus (others are dimmed), or null for the whole office. */
export function focusRoom(snapshot: AgencySnapshot, focus: StageFocus, lastRoom: string | null = null): string | null {
  if (focus.kind === 'room') return Object.hasOwn(snapshot.map.rooms, focus.room) ? focus.room : null;
  if (focus.kind !== 'actor') return null;
  if (focus.id === LUADY_ACTOR_ID) return HQ_ID;
  const actor = Object.hasOwn(snapshot.actors, focus.id) ? snapshot.actors[focus.id] : undefined;
  const room = actor?.room ?? lastRoom;
  return room !== null && Object.hasOwn(snapshot.map.rooms, room) ? room : null;
}

/** Most zoom per focus kind; the whole office is limited only by MAX_ZOOM. */
const MAX_SCALE: Readonly<Record<StageFocus['kind'], number>> = Object.freeze({ all: MAX_ZOOM, room: 2.6, actor: 3 });

/**
 * Where the camera aims for a focus: the whole-office view, or the fit of the focused room or actor, never farther out
 * than FOCUS_MIN (centred on it; what does not fit is a pan away). A focus that fell back to the whole building keeps
 * its fit.
 */
export function aimFor(snapshot: AgencySnapshot, focus: StageFocus, view: ViewSize, insets: StageInsets, lastRoom: string | null = null): CameraFit {
  if (focus.kind === 'all') return wholeOfficeFit(snapshot.map, view, insets);
  const target = focusRect(snapshot, focus, lastRoom);
  const fit = fitRect(target, view, insets, MAX_SCALE[focus.kind]);
  if (target === snapshot.map.zones.all || fit.scale >= FOCUS_MIN) return fit;
  return Object.freeze({ ...fit, scale: FOCUS_MIN });
}

/**
 * Clamps one axis: the free span stays within the building plus the pan margin; a span at least as large as the
 * building keeps it centred.
 */
const clampAxis = (centre: number, scale: number, size: number, before: number, after: number, lo: number, len: number): number => {
  const shift = (before - after) / 2 / scale;
  const span = Math.max(1, size - before - after) / scale;
  const freeCentre = centre + shift;
  const wanted = span >= len
    ? lo + len / 2
    : Math.max(lo - PAN_MARGIN + span / 2, Math.min(lo + len + PAN_MARGIN - span / 2, freeCentre));
  return wanted - shift;
};

/** Keeps a panned or zoomed camera over the building (plus PAN_MARGIN), taking the covered edges of the stage into account. */
export function clampCenter(center: PixelPoint, scale: number, view: ViewSize, insets: StageInsets, building: PixelRect): PixelPoint {
  return point(
    clampAxis(center.x, scale, view.width, insets.left, insets.right, building.x, building.w),
    clampAxis(center.y, scale, view.height, insets.top, insets.bottom, building.y, building.h),
  );
}
