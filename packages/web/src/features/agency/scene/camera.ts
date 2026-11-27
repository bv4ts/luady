import { roomRectPx, type AgencySnapshot, type PixelPoint, type PixelRect } from '@luady/office';
import { Viewport } from 'pixi-viewport';
import { Container, Sprite, Texture, type Application } from 'pixi.js';
import type { StageFocus, StageInsets } from '../stage-types.js';
import { MAX_ZOOM, aimFor, clampCenter, fitZoom, focusRect, focusRoom, viewCenter, type ViewSize } from './camera-math.js';

/** The camera: pixi-viewport for drag, wheel and pinch, plus focus glides and the dimming of other rooms. */
export interface Camera {
  readonly viewport: Viewport;
  /** Darkens the rooms around the focused one; add it above everything else in the viewport. */
  readonly dim: Container;
  /** Re-aims (gliding) when the focus, the insets or the focused area changed. The first call jumps. */
  update(snapshot: AgencySnapshot, focus: StageFocus, insets: StageInsets): void;
  setReducedMotion(on: boolean): void;
  /** New stage size in CSS pixels: re-aims at once. The same size again changes nothing. */
  resize(width: number, height: number): void;
  /** Once per frame: keeps a dragged camera over the building. True when the view moved since the last frame. */
  frame(): boolean;
  /** What the whole stage shows now: its world rectangle (map pixels), the zoom and the world point at its centre. */
  view(): CameraView;
  /** The world area that is not dimmed, or null when nothing is. */
  bright(): PixelRect | null;
  /** The focused room, if any (drawn with a hot frame). */
  room(): string | null;
  destroy(): void;
}

export interface CameraView { readonly rect: PixelRect; readonly scale: number; readonly centre: PixelPoint }

export interface CameraOptions {
  /** Called with the zoom whenever the view settles: a jump, the end of a glide, the end of a wheel or pinch zoom. */
  readonly onSettle?: (scale: number) => void;
}

const GLIDE_MS = 320;
/** Gap between a focused room and the dimmed area. */
const DIM_GAP = 3;
const DIM_REACH = 4096;
const DIM_TINT = 0x080b12;
const DIM_ALPHA = 0.58;
/** Size changes smaller than this (CSS pixels) are rounding, not a resize. */
const SAME_SIZE_PX = 1;
/** Before the first snapshot: the map size of the current layout, replaced by the snapshot's own. */
const NO_WORLD = { w: 1, h: 1 } as const;

const sameRect = (a: PixelRect | null, b: PixelRect | null): boolean => a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);
const sameInsets = (a: StageInsets, b: StageInsets): boolean => a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
const sameFocus = (a: StageFocus, b: StageFocus): boolean =>
  a.kind === b.kind && (a.kind !== 'room' || (b.kind === 'room' && a.room === b.room)) && (a.kind !== 'actor' || (b.kind === 'actor' && a.id === b.id));

const shade = (): Sprite => {
  const s = new Sprite(Texture.WHITE);
  Object.assign(s, { tint: DIM_TINT, alpha: DIM_ALPHA, visible: false });
  return s;
};

/** Four shades around `r` (a hole in the dark), reaching far past the map so the garden is dimmed too. */
const placeShades = (shades: readonly Sprite[], r: PixelRect | null, world: { readonly w: number; readonly h: number }): void => {
  shades.forEach((s) => { s.visible = r !== null; });
  if (r === null) return;
  const [top, bottom, left, right] = shades;
  const far = -DIM_REACH;
  const wide = DIM_REACH * 2 + world.w;
  if (top) Object.assign(top, { x: far, y: far, width: wide, height: r.y - far });
  if (bottom) Object.assign(bottom, { x: far, y: r.y + r.h, width: wide, height: world.h + DIM_REACH - r.y - r.h });
  if (left) Object.assign(left, { x: far, y: r.y, width: r.x - far, height: r.h });
  if (right) Object.assign(right, { x: r.x + r.w, y: r.y, width: world.w + DIM_REACH - r.x - r.w, height: r.h });
};

export function createCamera(app: Application, options: CameraOptions = {}): Camera {
  const viewport = new Viewport({
    screenWidth: app.screen.width, screenHeight: app.screen.height, worldWidth: NO_WORLD.w, worldHeight: NO_WORLD.h,
    events: app.renderer.events, ticker: app.ticker, disableOnContextMenu: true, ignoreWheelFromOtherElements: true,
  });
  // No .clamp(): its underflow centring ignores the panels over the stage; frame() clamps with the insets instead.
  viewport.drag().pinch().wheel().decelerate();
  const dim = new Container();
  dim.label = 'dim';
  const shades = [shade(), shade(), shade(), shade()];
  shades.forEach((s) => dim.addChild(s));

  let viewSize: ViewSize = { width: app.screen.width, height: app.screen.height };
  const lastRooms = new Map<string, string>();
  let snapshot: AgencySnapshot | null = null;
  let focus: StageFocus = { kind: 'all' };
  let insets: StageInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  let aimed: PixelRect | null = null;
  let reduced = false;
  let brightRect: PixelRect | null = null;
  let focused: string | null = null;
  let minZoom = 0;
  let last = '';

  const lastRoom = (): string | null => (focus.kind === 'actor' ? (lastRooms.get(focus.id) ?? null) : null);
  const settle = (): void => options.onSettle?.(viewport.scale.x);

  /** The zoom limits: out to the whole-building fit, in to MAX_ZOOM. */
  const limitZoom = (): void => {
    if (snapshot === null) return;
    const next = fitZoom(snapshot.map, viewSize, insets);
    if (Math.abs(next - minZoom) < 1e-9) return;
    minZoom = next;
    viewport.clampZoom({ minScale: minZoom, maxScale: Math.max(minZoom, MAX_ZOOM) });
  };

  const moveTo = (scale: number, center: PixelPoint, glide: boolean): void => {
    viewport.plugins.remove('animate');
    if (!glide || reduced) {
      viewport.scale.set(scale);
      viewport.moveCenter(center.x, center.y);
      settle();
      return;
    }
    viewport.animate({
      position: { x: center.x, y: center.y }, scale, time: GLIDE_MS, ease: 'easeInOutSine', removeOnInterrupt: true,
      callbackOnComplete: (vp) => {
        vp.scale.set(scale);
        vp.moveCenter(center.x, center.y);
        settle();
      },
    });
  };

  const aim = (glide: boolean): void => {
    if (snapshot === null) return;
    limitZoom();
    const fit = aimFor(snapshot, focus, viewSize, insets, lastRoom());
    moveTo(fit.scale, clampCenter(viewCenter(fit, insets), fit.scale, viewSize, insets, snapshot.map.zones.all), glide);
    aimed = focusRect(snapshot, focus, lastRoom());
  };

  const updateDim = (): void => {
    focused = snapshot === null ? null : focusRoom(snapshot, focus, lastRoom());
    const room = focused === null || snapshot === null ? undefined : snapshot.map.rooms[focused];
    const q = room === undefined ? null : roomRectPx(room);
    brightRect = q === null ? null : { x: q.x - DIM_GAP, y: q.y - DIM_GAP, w: q.w + DIM_GAP * 2, h: q.h + DIM_GAP * 2 };
    placeShades(shades, brightRect, snapshot === null ? NO_WORLD : { w: snapshot.map.width, h: snapshot.map.height });
  };

  /** A wheel or pinch zoom settled: draw it crisply at its new zoom. */
  const onZoomEnd = (): void => {
    if (viewport.plugins.get('animate') != null) return;
    settle();
  };
  viewport.on('zoomed-end', onZoomEnd);

  return {
    viewport,
    dim,
    update: (next, nextFocus, nextInsets) => {
      Object.values(next.actors).forEach((a) => lastRooms.set(a.id, a.room));
      const first = snapshot === null;
      const resized = snapshot === null || snapshot.map.width !== next.map.width || snapshot.map.height !== next.map.height;
      const moved = first || !sameFocus(focus, nextFocus) || !sameInsets(insets, nextInsets);
      snapshot = next;
      focus = nextFocus;
      insets = nextInsets;
      if (resized) viewport.resize(viewSize.width, viewSize.height, next.map.width, next.map.height);
      updateDim();
      if (moved || resized || !sameRect(aimed, focusRect(next, focus, lastRoom()))) aim(!first);
    },
    setReducedMotion: (on) => { reduced = on; },
    resize: (width, height) => {
      // A new renderer resolution rounds the canvas to whole pixels and reports a size a hair off: not a new size.
      if (Math.abs(width - viewSize.width) < SAME_SIZE_PX && Math.abs(height - viewSize.height) < SAME_SIZE_PX) return;
      viewSize = { width, height };
      viewport.resize(width, height, snapshot?.map.width ?? NO_WORLD.w, snapshot?.map.height ?? NO_WORLD.h);
      aim(false);
    },
    frame: () => {
      if (snapshot !== null && viewport.plugins.get('animate') == null) {
        const c = clampCenter(viewport.center, viewport.scale.x, viewSize, insets, snapshot.map.zones.all);
        if (Math.abs(c.x - viewport.center.x) > 0.01 || Math.abs(c.y - viewport.center.y) > 0.01) viewport.moveCenter(c.x, c.y);
      }
      const now = `${viewport.x},${viewport.y},${viewport.scale.x},${viewSize.width},${viewSize.height}`;
      const changed = now !== last;
      last = now;
      return changed;
    },
    view: () => {
      const a = viewport.toWorld(0, 0);
      const b = viewport.toWorld(viewSize.width, viewSize.height);
      const rect = Object.freeze({ x: a.x, y: a.y, w: Math.max(1e-6, b.x - a.x), h: Math.max(1e-6, b.y - a.y) });
      return Object.freeze({ rect, scale: viewport.scale.x, centre: Object.freeze({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }) });
    },
    bright: () => brightRect,
    room: () => focused,
    destroy: () => {
      viewport.off('zoomed-end', onZoomEnd);
      viewport.plugins.remove('animate');
    },
  };
}
