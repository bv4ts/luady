import { describe, expect, it } from 'vitest';
import { WALK_SPEED, stepWalk, type Walk } from '../../../../src/features/agency/scene/motion.js';

const walk = (points: { x: number; y: number }[], speed = 0.1): Walk => ({ points, speed });

describe('stepWalk', () => {
  it('walks at 66 px/s', () => {
    expect(WALK_SPEED).toBeCloseTo(0.066);
  });

  it('moves toward the next point by speed × time', () => {
    const r = stepWalk({ x: 0, y: 0 }, walk([{ x: 100, y: 0 }]), 0, 100);
    expect(r).toEqual({ pos: { x: 10, y: 0 }, index: 0, done: false });
  });

  it('turns corners within one step, carrying the leftover distance', () => {
    const r = stepWalk({ x: 0, y: 0 }, walk([{ x: 5, y: 0 }, { x: 5, y: 20 }]), 0, 100);
    expect(r.pos).toEqual({ x: 5, y: 5 });
    expect(r.index).toBe(1);
    expect(r.done).toBe(false);
  });

  it('reaches the last point exactly and never overshoots it', () => {
    const path = walk([{ x: 3.3, y: 0 }, { x: 3.3, y: 7.7 }]);
    let state = { pos: { x: 0, y: 0 }, index: 0, done: false };
    let guard = 0;
    while (!state.done && guard < 1000) {
      state = stepWalk(state.pos, path, state.index, 7);
      expect(state.pos.x).toBeLessThanOrEqual(3.3);
      expect(state.pos.y).toBeLessThanOrEqual(7.7);
      guard += 1;
    }
    expect(state).toEqual({ pos: { x: 3.3, y: 7.7 }, index: 2, done: true });
  });

  it('is done at once on an empty path, staying put', () => {
    expect(stepWalk({ x: 4, y: 9 }, walk([]), 0, 16)).toEqual({ pos: { x: 4, y: 9 }, index: 0, done: true });
  });

  it('finishes a whole path in one huge step', () => {
    const r = stepWalk({ x: 0, y: 0 }, walk([{ x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }]), 0, 1e9);
    expect(r).toEqual({ pos: { x: 0, y: 50 }, index: 3, done: true });
  });

  it('treats a negative or broken time as no time', () => {
    const w = walk([{ x: 10, y: 0 }]);
    expect(stepWalk({ x: 0, y: 0 }, w, 0, -50).pos).toEqual({ x: 0, y: 0 });
    expect(stepWalk({ x: 0, y: 0 }, w, 0, Number.NaN).pos).toEqual({ x: 0, y: 0 });
  });

  it('is done when the index is already past the end', () => {
    expect(stepWalk({ x: 1, y: 1 }, walk([{ x: 1, y: 1 }]), 1, 16).done).toBe(true);
  });
});
