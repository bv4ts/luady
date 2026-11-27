import { SPARKLE_FRAMES, type CritterFrame } from '@luady/office';

/** Timings of the signs that an agent works. All pure: the scene passes its clock in. */

/** One breath of the ring under a working character. */
export const PULSE_MS = 1400;
/** How long the arrival sparkle plays. */
export const SPARKLE_MS = 900;
const HELPER_STEP_MS = 180;
const HELPER_SWAY_MS = 300;

export interface Pulse { readonly alpha: number; readonly scale: number }
export interface HelperStep { readonly frame: CritterFrame; readonly bob: number; readonly dx: number }

const STILL_PULSE: Pulse = Object.freeze({ alpha: 0.55, scale: 1 });
const STILL_HELPER: HelperStep = Object.freeze({ frame: 'idle', bob: 0, dx: 0 });
/** The pulse in a few fixed steps of brightness (never of size, so its pixels stay whole); nothing is made per frame. */
const PULSE_STEPS: readonly Pulse[] = Object.freeze(
  [0, 1, 2, 3, 4, 3, 2, 1].map((k) => Object.freeze({ alpha: 0.45 + k * 0.125, scale: 1 })),
);
const HELPER_STEPS: readonly HelperStep[] = Object.freeze(
  (['idle', 'step'] as const).flatMap((frame) => [-1, 0, 1].map((dx) => Object.freeze({ frame, bob: frame === 'step' ? -1 : 0, dx }))),
);

const wrap = (n: number, m: number): number => ((Math.floor(n) % m) + m) % m;

/** The ring's alpha and scale at `now`; still (and half bright) with reduced motion. */
export function activityPulse(now: number, seed: number, reduced: boolean): Pulse {
  if (reduced || !Number.isFinite(now)) return STILL_PULSE;
  return PULSE_STEPS[wrap(((now + seed * 131) / PULSE_MS) * PULSE_STEPS.length, PULSE_STEPS.length)] ?? STILL_PULSE;
}

/** Helper `index` at `now`: stepping in place, bobbing on its step, swaying a pixel either way. Still with reduced motion. */
export function helperStep(now: number, index: number, seed: number, reduced: boolean): HelperStep {
  if (reduced || !Number.isFinite(now)) return STILL_HELPER;
  const t = now + index * 233 + seed * 17;
  const stepping = wrap(t / HELPER_STEP_MS, 2) === 1;
  const sway = wrap(t / HELPER_SWAY_MS, 4);
  const dx = sway === 1 ? 1 : sway === 3 ? -1 : 0;
  return HELPER_STEPS[(stepping ? 3 : 0) + dx + 1] ?? STILL_HELPER;
}

/** The sparkle frame `elapsed` ms after an arrival, or null once it has played. */
export function sparkleFrame(elapsed: number): number | null {
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= SPARKLE_MS) return null;
  return Math.min(SPARKLE_FRAMES - 1, Math.floor((elapsed / SPARKLE_MS) * SPARKLE_FRAMES));
}
