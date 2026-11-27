import { ambienceAt, type Ambience } from '@luady/office';
import { ownerZone } from '@luady/shared/pure';

/**
 * How the office looks for the light of the hour. Pure. The map's own art is the dusk look: at
 * DUSK_LIGHT nothing is added or tinted. Above it daylight lifts the garden and the floors and falls in through the
 * panes; below it the garden and the building darken and the lamps and panes glow.
 */
export interface AmbienceLook {
  /** Multiplies the garden and the building (0xffffff leaves them as drawn). */
  readonly gardenTint: number;
  readonly buildingTint: number;
  /** Strength (0..1) of the additive daylight over the garden and over the floors, and of the light through the panes. */
  readonly gardenDay: number;
  readonly indoorDay: number;
  readonly sun: number;
  /** The panes: tint and opacity of their glass (sky by day, lamp light by night), and the glow they spill outside. */
  readonly glassTint: number;
  readonly glass: number;
  readonly spill: number;
  /** The pools of light under the lamps at night. */
  readonly lamps: number;
  /** How much HQ's lights are lowered in quiet hours. */
  readonly quiet: number;
}

export interface LookOptions { readonly enabled: boolean; readonly quiet: boolean; readonly reduced: boolean }

/** The light (0 night … 1 day) that the map's art shows. */
export const DUSK_LIGHT = 0.5;
/** With reduced motion the light moves in these steps, never gradually. */
export const REDUCED_STEP = 0.25;

const NIGHT_GARDEN = 0x6c7aa0;
const NIGHT_BUILDING = 0xaab3c8;
export const SKY_GLASS = 0xa8d8f5;
export const LAMP_GLASS = 0xffd98a;
const QUIET_SHADE = 0.32;
/**
 * The most daylight added over the floors at noon. A flat additive lift raises the dark tones more than the light
 * ones, so at full strength floors, furniture and characters would lose their contrast indoors; the sun through the panes
 * carries the daylight instead.
 */
export const INDOOR_DAY_LIFT = 0.35;

const mixTint = (from: number, to: number, t: number): number => {
  const k = Math.max(0, Math.min(1, t));
  const ch = (shift: number): number => Math.round(((from >> shift) & 0xff) + (((to >> shift) & 0xff) - ((from >> shift) & 0xff)) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};

/** The look of the map's art as drawn: nothing added, nothing tinted. */
export const DUSK_LOOK: AmbienceLook = Object.freeze({
  gardenTint: 0xffffff, buildingTint: 0xffffff, gardenDay: 0, indoorDay: 0, sun: 0, glassTint: LAMP_GLASS, glass: 0, spill: 0, lamps: 0, quiet: 0,
});

/** The look for an ambience; off gives the dusk look always. Reduced motion rounds the light to REDUCED_STEP. */
export function ambienceLook(ambience: Ambience, options: LookOptions): AmbienceLook {
  if (!options.enabled) return DUSK_LOOK;
  const raw = Number.isFinite(ambience.light) ? Math.max(0, Math.min(1, ambience.light)) : DUSK_LIGHT;
  const light = options.reduced ? Math.round(raw / REDUCED_STEP) * REDUCED_STEP : raw;
  const day = Math.max(0, (light - DUSK_LIGHT) / (1 - DUSK_LIGHT));
  const night = Math.max(0, (DUSK_LIGHT - light) / DUSK_LIGHT);
  return Object.freeze({
    gardenTint: mixTint(0xffffff, NIGHT_GARDEN, night),
    buildingTint: mixTint(0xffffff, NIGHT_BUILDING, night),
    gardenDay: day,
    indoorDay: day * INDOOR_DAY_LIFT,
    sun: day,
    glassTint: day > 0 ? SKY_GLASS : LAMP_GLASS,
    glass: day > 0 ? day * 0.75 : night * 0.95,
    spill: night * 0.6,
    lamps: night * 0.55,
    quiet: options.quiet ? QUIET_SHADE : 0,
  });
}

/** The look at an instant (epoch ms) in the owner's zone, DST-safe through ambienceAt. */
export function lookAt(nowMs: number, options: LookOptions, tz: string = ownerZone()): AmbienceLook {
  return ambienceLook(ambienceAt(nowMs, tz), options);
}

/** True when two looks would draw the same picture (the scene skips redrawing then). */
export function sameLook(a: AmbienceLook, b: AmbienceLook): boolean {
  return (Object.keys(a) as (keyof AmbienceLook)[]).every((k) => Math.abs(a[k] - b[k]) < 1e-4);
}
