import { darken, lighten } from '../colors.js';
import { paint, type Raster } from '../raster.js';
import { paletteFor, type PaletteKey } from '../teams.js';
import type { Palette, Species } from '../types.js';
import { SPECIES, SPECIES_SIZE, frameRows, type CritterFrame } from './species.js';

const VARIANTS = 6;

/** Variant 0 keeps the colour; 1–5 give the five variant colours. */
const accentFor = (accent: string, variant: number): string => {
  switch (variant) {
    case 1: return lighten(accent, 0.35);
    case 2: return darken(accent, 0.3);
    case 3: return '#ffd84d';
    case 4: return '#e9eef7';
    case 5: return '#5aa2ff';
    default: return accent;
  }
};

/** Any number to 0..5: wraps around, rounds down, and treats NaN or infinity as 0. */
const normaliseVariant = (variant: number): number => {
  if (!Number.isFinite(variant)) return 0;
  return ((Math.floor(variant) % VARIANTS) + VARIANTS) % VARIANTS;
};

const isPaletteKey = (ch: string, palette: Readonly<Record<PaletteKey, string>>): ch is PaletteKey => Object.hasOwn(palette, ch);

/**
 * The letter a variant recolours: the accent 'a' (bun, bot, shield), else the star 'y' (ghost). The manager and the mini
 * helper have neither, so they stay single-look: every variant draws the same picture.
 */
const VARIANT_LETTER: Readonly<Record<Species, PaletteKey | null>> = Object.freeze(
  Object.fromEntries((Object.keys(SPECIES) as Species[]).map((s) => {
    const letters = SPECIES[s].rows.join('');
    return [s, letters.includes('a') ? 'a' : letters.includes('y') ? 'y' : null];
  })) as Record<Species, PaletteKey | null>,
);

/** One creature frame as a raster, in its room's palette and look variant (see VARIANT_LETTER). */
export function critterRaster(species: Species, palette: Palette, frame: CritterFrame, variant = 0): Raster {
  const base = paletteFor(palette);
  const letter = VARIANT_LETTER[species];
  const letters = letter === null ? base : Object.freeze({ ...base, [letter]: accentFor(base[letter], normaliseVariant(variant)) });
  const size = SPECIES_SIZE[species];
  const rows = frameRows(species, frame);
  return paint(size.w, size.h, (p) => {
    rows.forEach((row, y) => {
      Array.from(row).forEach((ch, x) => {
        if (isPaletteKey(ch, letters)) p.put(x, y, letters[ch]);
      });
    });
  });
}
