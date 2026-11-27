import type { CritterFrame, Pose, Species } from '@luady/office';

export interface PoseInput {
  readonly species: Species;
  readonly pose: Pose;
  readonly walking: boolean;
  readonly reduced: boolean;
  /** Milliseconds, any steady clock. */
  readonly now: number;
  /** Staggers blinks and wiggles between characters. */
  readonly seed: number;
}

/** Which frame to show, how far the body is lifted (negative = up) and how far the bubble is lifted. */
export interface PoseFrame { readonly frame: CritterFrame; readonly bob: number; readonly lift: number }

const STEP_MS = 140;
const BLINK_EVERY_MS = 4300;
const BLINK_MS = 140;
const TYPE_MS = 280;
const ALERT_MS = 220;
const GHOST_MS = 420;
const STILL: PoseFrame = Object.freeze({ frame: 'idle', bob: 0, lift: 0 });

const beat = (now: number, ms: number): number => Math.floor(now / ms) % 2;

const bobFor = (input: PoseInput): number => {
  const { species, pose, now, seed } = input;
  if (species === 'ghost') return Math.round(Math.sin(now / GHOST_MS + seed) * 1.4);
  if (pose === 'type') return beat(now + seed * 97, TYPE_MS) === 1 ? -1 : 0;
  if (pose === 'alert') return beat(now, ALERT_MS) === 1 ? -2 : 0;
  return 0;
};

/** The pose timings: steps while walking, blinks, typing wiggle, the alarm bounce and the ghost float. */
export function poseFrame(input: PoseInput): PoseFrame {
  if (input.reduced) return STILL;
  if (input.walking) {
    const step = beat(input.now, STEP_MS) === 1;
    return Object.freeze({ frame: step ? 'step' : 'idle', bob: step ? -1 : 0, lift: 0 });
  }
  const blink = (((input.now + input.seed * 613) % BLINK_EVERY_MS) + BLINK_EVERY_MS) % BLINK_EVERY_MS < BLINK_MS;
  const lift = input.pose === 'alert' && beat(input.now, ALERT_MS) === 1 ? -1 : 0;
  return Object.freeze({ frame: blink ? 'blink' : 'idle', bob: bobFor(input), lift });
}
