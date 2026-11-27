import type { StageEvent } from '../stage-types.js';
import { eventForHold, eventForTap, type Pick } from './picking.js';
import { createPressDetector, type PressPoint } from './press.js';

/** What input needs from the scene. Points are CSS pixels from the stage's top-left corner. */
export interface InputTarget {
  readonly canvas: HTMLCanvasElement;
  /** Subscribes to the camera's drag and pinch starts; returns an unsubscribe. */
  onGesture(start: () => void): () => void;
  pick(p: PressPoint): Pick;
  emit(event: StageEvent): void;
  /** The mouse is over this character, this fixture (id) and this room (desktop only). */
  hover(actor: string | null, fixture: string | null, room: string | null): void;
  setCursor(cursor: 'pointer' | 'default'): void;
}

export const HOLD_MS = 520;
const SLOP_PX = 6;

/**
 * Taps, holds and right-clicks on the canvas. A tap selects; a 520 ms hold or a right-click on a character opens its
 * menu (once per gesture, even when Android also fires contextmenu); a drag or a pinch never taps.
 */
export function attachInput(target: InputTarget): () => void {
  const { canvas } = target;
  const touches = new Set<number>();
  let menuShown = false;
  let hovered: string | null = null;
  let hoveredFixture: string | null = null;

  const local = (e: MouseEvent): PressPoint => {
    const box = canvas.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };
  const tap = (p: PressPoint): void => target.emit(eventForTap(target.pick(p)));
  const hold = (p: PressPoint): void => {
    const event = eventForHold(target.pick(p), p);
    if (event === null) return;
    menuShown = true;
    target.emit(event);
  };
  const touchPress = createPressDetector({ holdMs: HOLD_MS, slopPx: SLOP_PX, onTap: tap, onHold: hold });
  const mousePress = createPressDetector({ holdMs: Number.POSITIVE_INFINITY, slopPx: SLOP_PX, onTap: tap, onHold: () => undefined });
  const pressFor = (e: PointerEvent) => (e.pointerType === 'mouse' ? mousePress : touchPress);
  const cancelAll = (): void => {
    touchPress.cancel();
    mousePress.cancel();
  };

  const onDown = (e: PointerEvent): void => {
    menuShown = false;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType !== 'mouse') touches.add(e.pointerId);
    if (touches.size > 1) {
      cancelAll();
      return;
    }
    pressFor(e).down(local(e), e.pointerId);
  };

  /** A character wins over a fixture, a fixture over its room: only the front-most thing is hovered. */
  const hoverAt = (p: PressPoint): void => {
    const pick = target.pick(p);
    const fixture = pick.actor === null ? (pick.fixture?.id ?? null) : null;
    target.hover(pick.actor, fixture, pick.actor === null && fixture === null ? pick.room : null);
    target.setCursor(pick.actor !== null || fixture !== null || pick.room !== null ? 'pointer' : 'default');
    if (pick.actor === hovered && fixture === hoveredFixture) return;
    hovered = pick.actor;
    hoveredFixture = fixture;
    target.emit({ type: 'hover', id: pick.actor, fixture, x: p.x, y: p.y });
  };

  const onMove = (e: PointerEvent): void => {
    const p = local(e);
    pressFor(e).move(p, e.pointerId);
    if (e.pointerType === 'mouse') hoverAt(p);
  };

  const onUp = (e: PointerEvent): void => {
    touches.delete(e.pointerId);
    pressFor(e).up(local(e), e.pointerId);
  };

  const onCancel = (e: PointerEvent): void => {
    touches.delete(e.pointerId);
    cancelAll();
  };

  const onLeave = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return;
    target.hover(null, null, null);
    if (hovered === null && hoveredFixture === null) return;
    hovered = null;
    hoveredFixture = null;
    target.emit({ type: 'hover', id: null, fixture: null, x: 0, y: 0 });
  };

  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    cancelAll();
    if (menuShown) return;
    hold(local(e));
  };

  const stopGesture = target.onGesture(cancelAll);
  const listeners: readonly [string, EventListener][] = [
    ['pointerdown', onDown as EventListener],
    ['pointermove', onMove as EventListener],
    ['pointerup', onUp as EventListener],
    ['pointercancel', onCancel as EventListener],
    ['pointerleave', onLeave as EventListener],
    ['contextmenu', onContextMenu as EventListener],
  ];
  listeners.forEach(([type, fn]) => canvas.addEventListener(type, fn));
  return () => {
    stopGesture();
    cancelAll();
    listeners.forEach(([type, fn]) => canvas.removeEventListener(type, fn));
  };
}
