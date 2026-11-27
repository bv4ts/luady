import { SPECIES, SPECIES_SIZE, type Species } from '@luady/office';

/**
 * How a character picture sits on its feet: `w × h` is the frame (anchored bottom-centre, the feet on the bottom
 * row), `head` is the first painted row from the top (antennas, sprouts and the ghost's star included) and `tail` is
 * the row the status bubble's tail rests on: the top of the head itself, so the bubble may cover an antenna, a sprout
 * or a star but never the eyes. That keeps a bubble out of the desk front of the row above, where name plates go.
 */
export interface CritterBox { readonly w: number; readonly h: number; readonly head: number; readonly tail: number }

/** Every frame of the generated sheet is 24 × 24. */
export const SHEET_FRAME = 24;

/** First painted row of each species in the generated sheet (the same for every palette and frame; the cat's ear tips). */
const SHEET_HEAD: Readonly<Record<Species, number>> = Object.freeze({ bun: 0, bot: 1, shield: 1, ghost: 2, cat: 1, manager: 1, mini: 11 });
/**
 * Where the bubble's tail rests in the sheet: the sprout's stem, the antenna's foot, the shield's brow, the ghost's
 * crown, and for the cat the dip between its ears, one row above the line of its head.
 */
const SHEET_TAIL: Readonly<Record<Species, number>> = Object.freeze({ bun: 4, bot: 6, shield: 4, ghost: 4, cat: 3, manager: 0, mini: 10 });

const box = (w: number, h: number, head: number, tail: number): CritterBox => Object.freeze({ w, h, head, tail });

const SHEET_BOXES: Readonly<Record<Species, CritterBox>> = Object.freeze(
  Object.fromEntries((Object.keys(SHEET_HEAD) as Species[]).map((s) => [s, box(SHEET_FRAME, SHEET_FRAME, SHEET_HEAD[s], SHEET_TAIL[s])])) as Record<Species, CritterBox>,
);

const DRAWN_BOXES: Readonly<Record<Species, CritterBox>> = Object.freeze(
  Object.fromEntries((Object.keys(SPECIES) as Species[]).map((s) => {
    const head = Math.max(0, SPECIES[s].rows.findIndex((row) => /[^.]/.test(row)));
    return [s, box(SPECIES_SIZE[s].w, SPECIES_SIZE[s].h, head, head - 1)];
  })) as Record<Species, CritterBox>,
);

/** The box of a frame from the generated sheet. */
export function sheetBox(species: Species): CritterBox {
  return SHEET_BOXES[species];
}

/** The box of a code-drawn raster (the fallback when the sheet is missing). */
export function drawnBox(species: Species): CritterBox {
  return DRAWN_BOXES[species];
}

/** Painted height: from the head row down to the feet. */
export function bodyHeight(b: CritterBox): number {
  return b.h - b.head;
}
