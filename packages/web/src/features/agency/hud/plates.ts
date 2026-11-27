import type { OverlayPoint } from '../stage-types.js';

/**
 * The live name-plate nodes and the stage's latest points. Written every frame from `onFrame`,
 * straight to the DOM: React never re-renders for a moving character.
 */
export interface PlateRegistry {
  readonly nodes: Map<string, HTMLElement>;
  last: readonly OverlayPoint[];
}

export function createPlateRegistry(): PlateRegistry {
  return { nodes: new Map(), last: [] };
}

/**
 * Below this width the desks are too close for a plate: the type would no longer fit between the desk and the row
 * below, and the name would be a stub. Agent plates hide then (on a phone's whole-office view); the bell, the red
 * bubbles and the room panel still say who is who, and selecting an agent zooms in far enough to show its plate.
 */
export const PLATE_MIN_PX = 56;
/** Luady's plate keeps at least this width at any zoom: there is no desk beside his. */
export const LUADY_PLATE_PX = 48;

/** What was last written to each node, so unchanged frames cost no style write. */
const written = new WeakMap<HTMLElement, string>();

const usable = (point: OverlayPoint | undefined): point is OverlayPoint =>
  point !== undefined && point.visible && [point.x, point.footY, point.maxWidth].every(Number.isFinite);

const isManager = (node: HTMLElement): boolean => node.dataset.plate === 'manager';

/** An agent plate needs readable room between the desks; Luady's always fits. */
const fits = (node: HTMLElement, point: OverlayPoint): boolean => isManager(node) || point.maxWidth >= PLATE_MIN_PX;

/**
 * Shows a plate under its character (from `footY`, centred on `x`) no wider than the gap to the next desk, or hides it
 * when the point is missing, invisible, not a number, or too cramped for an agent's plate.
 */
export function placePlate(node: HTMLElement, point: OverlayPoint | undefined): void {
  const show = usable(point) && fits(node, point);
  if (node.hidden === show) node.hidden = !show;
  if (!show) return;
  const transform = `translate3d(${Math.round(point.x)}px, ${Math.round(point.footY)}px, 0px)`;
  const width = `${Math.floor(isManager(node) ? Math.max(LUADY_PLATE_PX, point.maxWidth) : point.maxWidth)}px`;
  const key = `${transform}|${width}`;
  if (written.get(node) === key) return;
  written.set(node, key);
  node.style.transform = transform;
  node.style.maxWidth = width;
}

/** Moves every plate to its actor; plates without a usable point are hidden, unknown points ignored. */
export function applyPoints(nodes: ReadonlyMap<string, HTMLElement>, points: readonly OverlayPoint[]): void {
  const byId = new Map(points.map((point) => [point.id, point]));
  nodes.forEach((node, id) => placePlate(node, byId.get(id)));
}
