import { describe, expect, it } from 'vitest';
import { PULSE_MS, SPARKLE_MS, activityPulse, helperStep, sparkleFrame } from '../../../../src/features/agency/scene/activity.js';

describe('activityPulse', () => {
  it('breathes between dim and bright over one pulse without changing size, and repeats', () => {
    const steps = Array.from({ length: 16 }, (_, i) => activityPulse((i * PULSE_MS) / 16, 0, false));
    const alphas = steps.map((s) => s.alpha);
    expect(Math.min(...alphas)).toBeCloseTo(0.45);
    expect(Math.max(...alphas)).toBeCloseTo(0.95);
    expect(activityPulse(PULSE_MS * 3 + 100, 0, false)).toBe(activityPulse(100, 0, false));
    steps.forEach((s) => expect(s.scale).toBe(1));
  });

  it('staggers characters by their seed and stays still with reduced motion', () => {
    expect(activityPulse(0, 3, false)).not.toBe(activityPulse(0, 0, false));
    expect(activityPulse(0, 0, true)).toBe(activityPulse(999, 7, true));
    expect(activityPulse(Number.NaN, 0, false)).toEqual({ alpha: 0.55, scale: 1 });
  });
});

describe('helperStep', () => {
  it('steps, bobs on the step and sways a pixel either way', () => {
    const steps = Array.from({ length: 40 }, (_, i) => helperStep(i * 50, 0, 0, false));
    expect(new Set(steps.map((s) => s.frame))).toEqual(new Set(['idle', 'step']));
    steps.forEach((s) => expect(s.bob).toBe(s.frame === 'step' ? -1 : 0));
    expect(new Set(steps.map((s) => s.dx))).toEqual(new Set([-1, 0, 1]));
  });

  it('moves helpers out of step with each other, and keeps them still with reduced motion', () => {
    const a = Array.from({ length: 20 }, (_, i) => helperStep(i * 50, 0, 0, false));
    const b = Array.from({ length: 20 }, (_, i) => helperStep(i * 50, 1, 0, false));
    expect(a).not.toEqual(b);
    expect(helperStep(123, 2, 5, true)).toEqual({ frame: 'idle', bob: 0, dx: 0 });
  });
});

describe('sparkleFrame', () => {
  it('plays four frames, then stops', () => {
    expect(sparkleFrame(0)).toBe(0);
    expect(sparkleFrame(SPARKLE_MS / 2)).toBe(2);
    expect(sparkleFrame(SPARKLE_MS - 1)).toBe(3);
    expect(sparkleFrame(SPARKLE_MS)).toBeNull();
    expect(sparkleFrame(-5)).toBeNull();
    expect(sparkleFrame(Number.NaN)).toBeNull();
  });
});
