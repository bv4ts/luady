import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPressDetector } from '../../../../src/features/agency/scene/press.js';

const setup = (holdMs = 520) => {
  const onTap = vi.fn();
  const onHold = vi.fn();
  const press = createPressDetector({ holdMs, slopPx: 6, onTap, onHold });
  return { press, onTap, onHold };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPressDetector', () => {
  it('taps on a quick press and release', () => {
    const { press, onTap, onHold } = setup();
    press.down({ x: 10, y: 10 }, 1);
    vi.advanceTimersByTime(200);
    press.up({ x: 12, y: 11 }, 1);
    vi.advanceTimersByTime(1000);
    expect(onTap).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledWith({ x: 12, y: 11 });
    expect(onHold).not.toHaveBeenCalled();
  });

  it('holds after 520 ms and never taps for the same gesture', () => {
    const { press, onTap, onHold } = setup();
    press.down({ x: 10, y: 10 }, 1);
    vi.advanceTimersByTime(519);
    expect(onHold).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onHold).toHaveBeenCalledWith({ x: 10, y: 10 });
    press.up({ x: 10, y: 10 }, 1);
    expect(onTap).not.toHaveBeenCalled();
    expect(onHold).toHaveBeenCalledTimes(1);
  });

  it('treats movement beyond the slop as a drag: neither tap nor hold', () => {
    const { press, onTap, onHold } = setup();
    press.down({ x: 10, y: 10 }, 1);
    press.move({ x: 15, y: 13 }, 1);
    press.move({ x: 17, y: 10 }, 1);
    vi.advanceTimersByTime(1000);
    press.up({ x: 17, y: 10 }, 1);
    expect(onTap).not.toHaveBeenCalled();
    expect(onHold).not.toHaveBeenCalled();
  });

  it('allows small jitter within the slop', () => {
    const { press, onTap } = setup();
    press.down({ x: 10, y: 10 }, 1);
    press.move({ x: 14, y: 14 }, 1);
    press.up({ x: 14, y: 14 }, 1);
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('suppresses both after cancel', () => {
    const { press, onTap, onHold } = setup();
    press.down({ x: 1, y: 1 }, 1);
    press.cancel();
    vi.advanceTimersByTime(1000);
    press.up({ x: 1, y: 1 }, 1);
    expect(onTap).not.toHaveBeenCalled();
    expect(onHold).not.toHaveBeenCalled();
  });

  it('cancels when a second finger lands (a pinch) and ignores other pointers', () => {
    const { press, onTap, onHold } = setup();
    press.down({ x: 1, y: 1 }, 1);
    press.up({ x: 1, y: 1 }, 2);
    press.down({ x: 50, y: 50 }, 2);
    vi.advanceTimersByTime(1000);
    press.up({ x: 1, y: 1 }, 1);
    press.up({ x: 50, y: 50 }, 2);
    expect(onTap).not.toHaveBeenCalled();
    expect(onHold).not.toHaveBeenCalled();
  });

  it('never holds when the hold time is infinite (mouse)', () => {
    const { press, onTap, onHold } = setup(Number.POSITIVE_INFINITY);
    press.down({ x: 1, y: 1 }, 1);
    vi.advanceTimersByTime(5000);
    press.up({ x: 1, y: 1 }, 1);
    expect(onHold).not.toHaveBeenCalled();
    expect(onTap).toHaveBeenCalledTimes(1);
  });

  it('starts fresh for the next gesture', () => {
    const { press, onTap, onHold } = setup();
    press.down({ x: 1, y: 1 }, 1);
    vi.advanceTimersByTime(600);
    press.up({ x: 1, y: 1 }, 1);
    press.down({ x: 2, y: 2 }, 3);
    press.up({ x: 2, y: 2 }, 3);
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(onTap).toHaveBeenCalledTimes(1);
  });
});
