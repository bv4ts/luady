import { describe, expect, it } from 'vitest';
import { poseFrame, type PoseInput } from '../../../../src/features/agency/scene/poses.js';

const input = (over: Partial<PoseInput> = {}): PoseInput => ({ species: 'bun', pose: 'sit', walking: false, reduced: false, now: 1000, seed: 0, ...over });

describe('poseFrame (pose timings)', () => {
  it('steps every 140 ms while walking, bobbing on the step', () => {
    expect(poseFrame(input({ walking: true, now: 0 }))).toEqual({ frame: 'idle', bob: 0, lift: 0 });
    expect(poseFrame(input({ walking: true, now: 140 }))).toEqual({ frame: 'step', bob: -1, lift: 0 });
  });

  it('blinks for 140 ms every 4.3 s, staggered by seed', () => {
    expect(poseFrame(input({ now: 4300 })).frame).toBe('blink');
    expect(poseFrame(input({ now: 4300 + 150 })).frame).toBe('idle');
    expect(poseFrame(input({ now: 4300, seed: 1 })).frame).toBe('idle');
  });

  it('wiggles while typing every 280 ms and bounces a raised bubble when it needs the owner', () => {
    expect(poseFrame(input({ pose: 'type', now: 280 })).bob).toBe(-1);
    expect(poseFrame(input({ pose: 'type', now: 560 })).bob).toBe(0);
    expect(poseFrame(input({ pose: 'alert', now: 220 }))).toMatchObject({ bob: -2, lift: -1 });
    expect(poseFrame(input({ pose: 'alert', now: 440 }))).toMatchObject({ bob: 0, lift: 0 });
  });

  it('floats ghosts', () => {
    const bobs = new Set([0, 300, 600, 900, 1200].map((now) => poseFrame(input({ species: 'ghost', now })).bob));
    expect(bobs.size).toBeGreaterThan(1);
  });

  it('keeps still with reduced motion', () => {
    for (const pose of ['type', 'alert', 'sit'] as const) {
      expect(poseFrame(input({ pose, reduced: true, now: 4300 + 220 }))).toEqual({ frame: 'idle', bob: 0, lift: 0 });
    }
  });
});
