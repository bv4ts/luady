import type { RackView } from '@luady/office';

/** One row of a rack's front: the activity light (left) and the team light (right), as 0xrrggbb tints. */
export interface RackLightRow { readonly activity: number; readonly team: number }

export const RACK_ROWS = 6;

const GREEN = 0x54d38a;
const AMBER = 0xffb648;
const RED = 0xe23a2e;
const DARK_ACTIVITY = 0x1f3b2d;
const DARK_TEAM = 0x27324a;
const SLOWEST_MS = 900;
const FASTEST_MS = 160;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/** How long one blink step of the activity lights lasts: slow when the server is idle, fast under full load. */
export function blinkPeriod(load: number): number {
  return Math.round(SLOWEST_MS - (SLOWEST_MS - FASTEST_MS) * clamp01(load));
}

/** Red when the disk is low, amber when memory is tight, green otherwise. */
const activityColour = (rack: RackView): number => (rack.disk === 'low' ? RED : rack.memory === 'tight' ? AMBER : GREEN);

/**
 * The lights of one rack at a moment. Dark when the hub has no numbers yet or the server is
 * not online. `seed` staggers racks so they do not blink in step; pass `nowMs = 0` for a still picture.
 */
export function rackLights(rack: RackView | null, teamColour: number, nowMs: number, seed: number): readonly RackLightRow[] {
  if (rack === null || rack.status !== 'online') {
    return Array.from({ length: RACK_ROWS }, () => ({ activity: DARK_ACTIVITY, team: DARK_TEAM }));
  }
  const period = blinkPeriod(rack.load);
  const lit = activityColour(rack);
  return Array.from({ length: RACK_ROWS }, (_, i) => ({
    activity: Math.floor(nowMs / period + i * 3 + seed) % 4 !== 0 ? lit : DARK_ACTIVITY,
    team: Math.floor(nowMs / (period * 1.5) + i * 5 + seed) % 3 === 0 ? teamColour : DARK_TEAM,
  }));
}

/** '#rrggbb' → 0xrrggbb. */
export function hexToTint(hex: string): number {
  const value = Number.parseInt(hex.replace(/^#/, ''), 16);
  return Number.isFinite(value) ? value : 0xffffff;
}
