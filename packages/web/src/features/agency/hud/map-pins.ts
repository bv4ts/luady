import type { OverlayKind, OverlayPoint } from '../stage-types.js';

/** A plaque sits this far inside its room's corner. */
export const PLAQUE_INSET_PX = 6;
/** Below this zoom (whole office on a phone) the plaques would cover the desks: they hide. */
export const PLAQUE_MIN_SCALE = 0.75;

/**
 * 'wall': a server room's plaque hangs on the back wall above the floor corner (the CSS lifts it by its own height), so
 * it never covers the first row of desks; 'wall-end' hangs it at the far end of that wall (east rooms are mirrored:
 * their rack and board sit at the near end). 'plaque': on the floor corner (HQ, whose wall holds the board).
 */
/** 'dot': a badge without a number, on the top-centre of its fixture (the TV's alarm sits clear of its neighbours'). */
/**
 * 'far': a room's far-mode badge, centred on its top inside edge at any zoom. 'lot': an empty slot's "+ Add room"
 * plaque, the same place, from LOT_MIN_SCALE on.
 */
export type PinMode = 'wall' | 'wall-end' | 'plaque' | 'badge' | 'dot' | 'far' | 'lot';
/** Below this zoom an empty slot's "+ Add room" plaque would crowd the map: it hides. */
export const LOT_MIN_SCALE = 0.3;
/** A far badge or lot plaque sits this far below its room's top inside edge (CSS pixels). */
const FAR_INSET_PX = 4;
/** Between a wall plaque and the floor. */
export const WALL_GAP_PX = 4;
/** Between a wall plaque and the next fixture on its wall. */
export const PLAQUE_GAP_PX = 4;
/** Half a badge chip's height (the CSS centres the chip on its point). */
export const BADGE_HALF_PX = 10;
/** Kept between a badge and a bar. */
const BADGE_EDGE_PX = 2;
/** How far a badge may slide down its fixture's picture (map pixels): about the height of the tallest fixture art. */
export const BADGE_SLIDE_MAP_PX = 34;

/** The free band between the top bar and the chat bar, in the pins' own pixels. */
export interface PinBand {
  readonly top: number;
  readonly bottom: number;
}

/** A box in the pins' own pixels. */
export interface PinRect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }

/** Between a lot plaque and an area it keeps clear of (a notice toast). */
export const LOT_CLEAR_GAP_PX = 6;

/**
 * A lot plaque (centred on its x, `size` big) moved down below every area it would sit under (the notice toasts at the
 * top right): it stays readable and pressable, never covered.
 */
export function clearOfAreas(spot: PinSpot, size: { readonly w: number; readonly h: number }, areas: readonly PinRect[]): PinSpot {
  const left = spot.x - size.w / 2;
  const right = spot.x + size.w / 2;
  let y = spot.y;
  for (const area of areas.toSorted((a, b) => a.y - b.y)) {
    const meets = left < area.x + area.w && area.x < right && y < area.y + area.h && area.y < y + size.h;
    if (meets) y = area.y + area.h + LOT_CLEAR_GAP_PX;
  }
  return y === spot.y ? spot : { ...spot, y };
}

/** The notice toasts of the office page in the pins' own pixels (both layers fill the page). */
function toastAreas(node: HTMLElement): readonly PinRect[] {
  const page = node.closest('.agency');
  const layer = node.offsetParent ?? node.parentElement;
  if (page === null || layer === null) return [];
  const origin = layer.getBoundingClientRect();
  return [...page.querySelectorAll('.notice-toast')].flatMap((toast) => {
    const r = toast.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? [{ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }] : [];
  });
}

export interface PinSpot {
  readonly x: number;
  readonly y: number;
  /** The widest the pin may be (a plaque stays inside its room); null for no limit. */
  readonly maxWidth: number | null;
}

const usable = (point: OverlayPoint | undefined): point is OverlayPoint =>
  point !== undefined && point.visible && [point.x, point.y, point.maxWidth, point.scale].every(Number.isFinite);

/**
 * Where a pin goes: a room's plaque inside its top-left corner, no wider than the room; a fixture's badge on the
 * top-right corner of its picture (the CSS centres the chip on that point). Null when it should not show.
 */
/**
 * `wallRun`: for a wall plaque, the free run of the back wall in map pixels (model/map-labels.ts plaqueWallRun): the
 * plaque is no wider than that, so it never covers the next wall fixture.
 */
export function pinSpot(point: OverlayPoint | undefined, mode: PinMode, band?: PinBand, wallRun?: number): PinSpot | null {
  if (!usable(point)) return null;
  if (mode === 'dot') return { x: point.x, y: point.y, maxWidth: null };
  if (mode === 'far' || mode === 'lot') {
    if (mode === 'lot' && point.scale < LOT_MIN_SCALE) return null;
    return { x: point.x + point.maxWidth / 2, y: point.y + FAR_INSET_PX, maxWidth: Math.max(0, point.maxWidth) };
  }
  if (mode !== 'badge') {
    if (point.scale < PLAQUE_MIN_SCALE) return null;
    const y = mode === 'plaque' ? point.y + PLAQUE_INSET_PX : point.y - WALL_GAP_PX;
    const x = mode === 'wall-end' ? point.x + point.maxWidth - PLAQUE_INSET_PX : point.x + PLAQUE_INSET_PX;
    const room = point.maxWidth - 2 * PLAQUE_INSET_PX;
    const run = mode === 'plaque' || wallRun === undefined ? room : wallRun * point.scale - PLAQUE_INSET_PX - PLAQUE_GAP_PX;
    return { x, y, maxWidth: Math.max(0, Math.min(room, run)) };
  }
  const x = point.x + point.maxWidth / 2;
  if (band === undefined) return { x, y: point.y, maxWidth: null };
  // A badge stays fully visible: below the top bar and above the chat bar, sliding down along its fixture; a fixture
  // wholly under the top bar shows none.
  const lowest = point.y + BADGE_SLIDE_MAP_PX * point.scale;
  const minY = band.top + BADGE_HALF_PX + BADGE_EDGE_PX;
  const maxY = band.bottom - BADGE_HALF_PX - BADGE_EDGE_PX;
  if (lowest < minY || point.y > maxY + BADGE_HALF_PX) return null;
  return { x, y: Math.min(Math.max(point.y, minY), maxY), maxWidth: null };
}

/** The key a pin's point has in a frame: kinds keep room keys and fixture ids apart. */
export const pinKey = (kind: OverlayKind, id: string): string => `${kind}:${id}`;

const written = new WeakMap<HTMLElement, string>();

/** Writes a pin's place straight to the DOM (no React render per frame); hides it when it should not show. */
export function placePin(node: HTMLElement, point: OverlayPoint | undefined, mode: PinMode, band?: PinBand, wallRun?: number): void {
  const at = pinSpot(point, mode, band, wallRun);
  const spot = at === null || mode !== 'lot' ? at : clearOfAreas(at, { w: node.offsetWidth, h: node.offsetHeight }, toastAreas(node));
  const key = spot === null ? 'hidden' : `${Math.round(spot.x)}|${Math.round(spot.y)}|${spot.maxWidth === null ? '' : Math.floor(spot.maxWidth)}`;
  if (written.get(node) === key) return;
  written.set(node, key);
  node.hidden = spot === null;
  if (spot === null) return;
  node.style.transform = `translate3d(${Math.round(spot.x)}px, ${Math.round(spot.y)}px, 0px)`;
  if (spot.maxWidth !== null) node.style.maxWidth = `${Math.floor(spot.maxWidth)}px`;
}

/** The live pin nodes, by pin key, with their mode. */
export interface PinRegistry {
  readonly nodes: Map<string, { node: HTMLElement; mode: PinMode; wallRun?: number }>;
}

export function createPinRegistry(): PinRegistry {
  return { nodes: new Map() };
}

/** Moves every pin to its point in this frame. */
export function applyPins(registry: PinRegistry, points: readonly OverlayPoint[], band?: PinBand): void {
  const byKey = new Map(points.map((point) => [pinKey(point.kind, point.id), point]));
  registry.nodes.forEach(({ node, mode, wallRun }, key) => placePin(node, byKey.get(key), mode, band, wallRun));
}
