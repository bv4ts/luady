import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachInput, type InputTarget } from '../../../../src/features/agency/scene/input.js';
import type { Pick } from '../../../../src/features/agency/scene/picking.js';
import type { StageEvent } from '../../../../src/features/agency/stage-types.js';
import { snap } from './office-fixtures.js';

interface PointerInit { readonly x: number; readonly y: number; readonly id?: number; readonly kind?: string; readonly button?: number }

const fire = (el: HTMLElement, type: string, init: PointerInit): Event => {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: init.x, clientY: init.y, button: init.button ?? 0 });
  Object.defineProperties(e, { pointerId: { value: init.id ?? 1 }, pointerType: { value: init.kind ?? 'touch' } });
  el.dispatchEvent(e);
  return e;
};

const setup = (pick: (p: { x: number; y: number }) => Pick) => {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const events: StageEvent[] = [];
  let gesture: () => void = () => undefined;
  const target: InputTarget = {
    canvas,
    onGesture: (start) => {
      gesture = start;
      return () => { gesture = () => undefined; };
    },
    pick,
    emit: (e) => events.push(e),
    hover: vi.fn(),
    setCursor: vi.fn(),
  };
  const detach = attachInput(target);
  return { canvas, events, target, detach, startGesture: () => gesture() };
};

const onActor = (): Pick => ({ actor: 'birch:a', fixture: null, room: 'birch' });
const onFloor = (): Pick => ({ actor: null, fixture: null, room: 'birch' });
const board = snap([]).fixtures.find((f) => f.id === 'board-hq')!;
const onBoard = (): Pick => ({ actor: null, fixture: board, room: 'hq' });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('attachInput', () => {
  it('turns a quick touch into a tap on the thing under it', () => {
    const { canvas, events } = setup(onActor);
    fire(canvas, 'pointerdown', { x: 10, y: 10 });
    fire(canvas, 'pointerup', { x: 11, y: 10 });
    expect(events).toEqual([{ type: 'actor', id: 'birch:a' }]);
  });

  it('opens the menu after a 520 ms hold on a character, once, even when the browser also sends contextmenu', () => {
    const { canvas, events } = setup(onActor);
    fire(canvas, 'pointerdown', { x: 30, y: 40 });
    vi.advanceTimersByTime(520);
    fire(canvas, 'contextmenu', { x: 30, y: 40 });
    fire(canvas, 'pointerup', { x: 30, y: 40 });
    expect(events).toEqual([{ type: 'menu', id: 'birch:a', x: 30, y: 40 }]);
  });

  it('opens the menu once when contextmenu comes before the hold timer', () => {
    const { canvas, events } = setup(onActor);
    fire(canvas, 'pointerdown', { x: 30, y: 40 });
    vi.advanceTimersByTime(450);
    const menu = fire(canvas, 'contextmenu', { x: 30, y: 40 });
    vi.advanceTimersByTime(500);
    fire(canvas, 'pointerup', { x: 30, y: 40 });
    expect(menu.defaultPrevented).toBe(true);
    expect(events).toEqual([{ type: 'menu', id: 'birch:a', x: 30, y: 40 }]);
  });

  it('opens the menu on a right-click and never taps for it', () => {
    const { canvas, events } = setup(onActor);
    fire(canvas, 'pointerdown', { x: 5, y: 6, kind: 'mouse', button: 2 });
    fire(canvas, 'contextmenu', { x: 5, y: 6, kind: 'mouse', button: 2 });
    fire(canvas, 'pointerup', { x: 5, y: 6, kind: 'mouse', button: 2 });
    expect(events).toEqual([{ type: 'menu', id: 'birch:a', x: 5, y: 6 }]);
  });

  it('does nothing for a hold on the floor', () => {
    const { canvas, events } = setup(onFloor);
    fire(canvas, 'pointerdown', { x: 5, y: 6 });
    vi.advanceTimersByTime(800);
    fire(canvas, 'pointerup', { x: 5, y: 6 });
    expect(events).toEqual([]);
  });

  it('never taps for a drag, a pinch or a camera gesture', () => {
    const { canvas, events, startGesture } = setup(onFloor);
    fire(canvas, 'pointerdown', { x: 10, y: 10 });
    fire(canvas, 'pointermove', { x: 40, y: 10 });
    fire(canvas, 'pointerup', { x: 40, y: 10 });
    fire(canvas, 'pointerdown', { x: 10, y: 10, id: 1 });
    fire(canvas, 'pointerdown', { x: 90, y: 90, id: 2 });
    fire(canvas, 'pointerup', { x: 10, y: 10, id: 1 });
    fire(canvas, 'pointerup', { x: 90, y: 90, id: 2 });
    fire(canvas, 'pointerdown', { x: 10, y: 10, id: 3 });
    startGesture();
    fire(canvas, 'pointerup', { x: 10, y: 10, id: 3 });
    expect(events).toEqual([]);
  });

  it('a slow mouse click is still a click', () => {
    const { canvas, events } = setup(onFloor);
    fire(canvas, 'pointerdown', { x: 10, y: 10, kind: 'mouse' });
    vi.advanceTimersByTime(2000);
    fire(canvas, 'pointerup', { x: 10, y: 10, kind: 'mouse' });
    expect(events).toEqual([{ type: 'room', room: 'birch' }]);
  });

  it('reports mouse hover changes only, and clears on leave', () => {
    let pick: Pick = onFloor();
    const { canvas, events, target } = setup(() => pick);
    fire(canvas, 'pointermove', { x: 1, y: 1, kind: 'mouse' });
    pick = onActor();
    fire(canvas, 'pointermove', { x: 2, y: 2, kind: 'mouse' });
    fire(canvas, 'pointermove', { x: 3, y: 2, kind: 'mouse' });
    fire(canvas, 'pointermove', { x: 3, y: 2, kind: 'touch' });
    fire(canvas, 'pointerleave', { x: 3, y: 2, kind: 'mouse' });
    expect(events).toEqual([{ type: 'hover', id: 'birch:a', fixture: null, x: 2, y: 2 }, { type: 'hover', id: null, fixture: null, x: 0, y: 0 }]);
    expect(target.setCursor).toHaveBeenLastCalledWith('pointer');
  });

  it('reports a fixture under the mouse in hover events, highlights it instead of its room, and taps it', () => {
    let pick: Pick = onFloor();
    const { canvas, events, target } = setup(() => pick);
    fire(canvas, 'pointermove', { x: 1, y: 1, kind: 'mouse' });
    expect(target.hover).toHaveBeenLastCalledWith(null, null, 'birch');
    pick = onBoard();
    fire(canvas, 'pointermove', { x: 2, y: 2, kind: 'mouse' });
    fire(canvas, 'pointermove', { x: 3, y: 2, kind: 'mouse' });
    expect(target.hover).toHaveBeenLastCalledWith(null, 'board-hq', null);
    expect(target.setCursor).toHaveBeenLastCalledWith('pointer');
    fire(canvas, 'pointerdown', { x: 3, y: 2, kind: 'mouse' });
    fire(canvas, 'pointerup', { x: 3, y: 2, kind: 'mouse' });
    fire(canvas, 'pointerleave', { x: 3, y: 2, kind: 'mouse' });
    expect(events).toEqual([
      { type: 'hover', id: null, fixture: 'board-hq', x: 2, y: 2 },
      { type: 'fixture', fixture: 'board', id: 'board-hq', room: 'hq' },
      { type: 'hover', id: null, fixture: null, x: 0, y: 0 },
    ]);
  });

  it('stops listening when detached', () => {
    const { canvas, events, detach } = setup(onActor);
    detach();
    fire(canvas, 'pointerdown', { x: 1, y: 1 });
    fire(canvas, 'pointerup', { x: 1, y: 1 });
    expect(events).toEqual([]);
  });
});
