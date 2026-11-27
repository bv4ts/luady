export interface PressPoint { readonly x: number; readonly y: number }

export interface PressOptions {
  /** Press this long without moving: a hold. Infinity: never (mouse). */
  readonly holdMs: number;
  /** Moving further than this from the start turns the press into a drag. */
  readonly slopPx: number;
  onTap(p: PressPoint): void;
  onHold(p: PressPoint): void;
}

export interface PressDetector {
  down(p: PressPoint, id: number): void;
  move(p: PressPoint, id: number): void;
  up(p: PressPoint, id: number): void;
  /** Forget the current press: no tap and no hold for it. */
  cancel(): void;
}

interface Press { readonly id: number; readonly start: PressPoint; readonly timer: ReturnType<typeof setTimeout> | null; readonly held: boolean }

/**
 * Tells a tap from a hold from a drag for one pointer at a time. Exactly one of onTap / onHold fires per press, or
 * neither when it moved beyond the slop, a second pointer arrived (a pinch) or it was cancelled.
 */
export function createPressDetector(options: PressOptions): PressDetector {
  let press: Press | null = null;

  const clear = (): void => {
    if (press?.timer != null) clearTimeout(press.timer);
    press = null;
  };

  const hold = (id: number): void => {
    if (press === null || press.id !== id || press.held) return;
    const start = press.start;
    press = { ...press, timer: null, held: true };
    options.onHold(start);
  };

  return {
    down: (p, id) => {
      if (press !== null && press.id !== id) {
        clear();
        return;
      }
      clear();
      const timer = Number.isFinite(options.holdMs) ? setTimeout(() => hold(id), Math.max(0, options.holdMs)) : null;
      press = { id, start: { x: p.x, y: p.y }, timer, held: false };
    },
    move: (p, id) => {
      if (press === null || press.id !== id) return;
      if (Math.hypot(p.x - press.start.x, p.y - press.start.y) > options.slopPx) clear();
    },
    up: (p, id) => {
      if (press === null || press.id !== id) return;
      const held = press.held;
      clear();
      if (!held) options.onTap({ x: p.x, y: p.y });
    },
    cancel: clear,
  };
}
