import { darken, lighten } from './colors.js';
import type { Palette } from './types.js';

/** HQ's fixed colours. */
export const HQ_PALETTE: Palette = Object.freeze({ base: '#3cc3b0', accent: '#ffd84d' });
/** The neutral grey of empty slots, paused agents and anything without a room. */
export const MUTE_PALETTE: Palette = Object.freeze({ base: '#6c7689', accent: '#8a93a5' });

/** Sprite letters: o outline, b body, s shade, h highlight, w eye, p pupil, a accent, k bow tie, g glasses, y star. */
export type PaletteKey = 'o' | 'b' | 's' | 'h' | 'w' | 'p' | 'a' | 'k' | 'g' | 'y';

/** The colour of each sprite letter for one room palette. */
export function paletteFor(palette: Palette): Readonly<Record<PaletteKey, string>> {
  return Object.freeze({
    o: darken(palette.base, 0.78),
    b: palette.base,
    s: darken(palette.base, 0.3),
    h: lighten(palette.base, 0.42),
    w: '#ffffff',
    p: '#141a26',
    a: palette.accent,
    k: '#10141d',
    g: '#10141d',
    y: '#ffd84d',
  });
}
