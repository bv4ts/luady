import type { DelegateTo, RoomDTO, SessionDTO } from '@luady/shared';
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { reportError } from '../../../lib/report.js';
import type { StageHandle, StageTarget } from '../stage-types.js';
import { IDLE, dropOf, dropTargetOf, reduceDrag, type DragInput, type DragLoad, type DragState } from './drag.js';

/** The page marks itself while something is dragged: give.css shrinks the open pop-up out of the way. */
export const DRAGGING_ATTR = 'data-give-dragging';

/** Client coordinates → CSS pixels from the stage's top-left corner (the map fills the office page). */
function stagePoint(clientX: number, clientY: number): { x: number; y: number } {
  const stage = document.querySelector('.agency__stage');
  const box = stage?.getBoundingClientRect();
  return { x: clientX - (box?.left ?? 0), y: clientY - (box?.top ?? 0) };
}

const hintKey = (hint: StageTarget | null): string => (hint === null ? '' : hint.kind === 'room' ? `room:${hint.room}` : `${hint.kind}:${hint.id}`);

export interface DragDrop {
  readonly load: DragLoad;
  readonly to: DelegateTo;
}

interface DragDeps {
  readonly stage: RefObject<StageHandle | null>;
  readonly sessions: RefObject<readonly SessionDTO[]>;
  /** The office's rooms: a drop on a room starts a session on its host. */
  readonly rooms: RefObject<readonly RoomDTO[]>;
  readonly onDrop: (drop: DragDrop) => void;
}

/**
 * Dragging with the pointer (mouse, pen and touch alike; no HTML5 drag-and-drop). The handle captures the pointer, the
 * window listens in the capture phase (so the pop-up frame and the map never see the gesture), `stage.pick` finds what
 * is under the pointer and `setDropHint` lights it, release sends, Esc or a cancelled pointer restores everything.
 */
export function useDrag({ stage, sessions, rooms, onDrop }: DragDeps) {
  const [state, setState] = useState<DragState>(IDLE);
  const current = useRef<DragState>(IDLE);
  const hint = useRef('');
  const detach = useRef<(() => void) | null>(null);
  const dropRef = useRef(onDrop);
  useEffect(() => {
    dropRef.current = onDrop;
  }, [onDrop]);

  const apply = useCallback((input: DragInput): DragState => {
    const next = reduceDrag(current.current, input);
    if (next !== current.current) {
      current.current = next;
      setState(next);
    }
    return next;
  }, []);

  const light = useCallback((target: StageTarget | null) => {
    const key = hintKey(target);
    if (key === hint.current) return;
    hint.current = key;
    try {
      stage.current?.setDropHint(target);
    } catch (err) {
      reportError('drop hint', err);
    }
  }, [stage]);

  const finish = useCallback(() => {
    detach.current?.();
    detach.current = null;
    light(null);
    apply({ type: 'cancel' });
  }, [apply, light]);

  const pickAt = useCallback((clientX: number, clientY: number): StageTarget | null => {
    const point = stagePoint(clientX, clientY);
    try {
      const raw = stage.current?.pick(point.x, point.y) ?? null;
      return dropTargetOf(raw, sessions.current, rooms.current)?.hint ?? null;
    } catch (err) {
      reportError('drop pick', err);
      return null;
    }
  }, [stage, sessions, rooms]);

  const startDrag = useCallback((load: DragLoad, event: ReactPointerEvent) => {
    if (current.current.phase !== 'idle' || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    event.stopPropagation();
    const { pointerId } = event;
    const handle = event.currentTarget;
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      // jsdom and some old browsers cannot capture; the window listeners below still see the gesture.
    }
    apply({ type: 'press', load, pointerId, x: event.clientX, y: event.clientY });

    const onMove = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      e.preventDefault();
      const target = pickAt(e.clientX, e.clientY);
      const next = apply({ type: 'move', pointerId, x: e.clientX, y: e.clientY, target });
      if (next.phase === 'dragging') light(target);
    };
    const onUp = (e: PointerEvent): void => {
      if (e.pointerId !== pointerId) return;
      e.stopPropagation();
      const drop = dropOf(current.current, sessions.current, rooms.current);
      finish();
      if (drop !== null) dropRef.current(drop);
    };
    const onCancel = (e: PointerEvent): void => {
      if (e.pointerId === pointerId) finish();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      finish();
    };
    const options = { capture: true } as const;
    window.addEventListener('pointermove', onMove, options);
    window.addEventListener('pointerup', onUp, options);
    window.addEventListener('pointercancel', onCancel, options);
    window.addEventListener('keydown', onKey, options);
    detach.current = () => {
      window.removeEventListener('pointermove', onMove, options);
      window.removeEventListener('pointerup', onUp, options);
      window.removeEventListener('pointercancel', onCancel, options);
      window.removeEventListener('keydown', onKey, options);
      try {
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      } catch {
        // Already released.
      }
    };
  }, [apply, finish, light, pickAt, sessions, rooms]);

  const dragging = state.phase === 'dragging';
  useEffect(() => {
    const root = document.documentElement;
    if (dragging) root.setAttribute(DRAGGING_ATTR, '');
    else root.removeAttribute(DRAGGING_ATTR);
    return () => root.removeAttribute(DRAGGING_ATTR);
  }, [dragging]);

  useEffect(() => () => {
    detach.current?.();
    detach.current = null;
  }, []);

  return { state, startDrag, cancel: finish };
}
