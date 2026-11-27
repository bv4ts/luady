import type { Species } from '../types.js';

/** A creature drawn from letter rows (see PaletteKey). feetRow is swapped for feetStep on the step frame; -1 means no feet. */
export interface SpeciesArt { readonly rows: readonly string[]; readonly feetRow: number; readonly feetStep: string }

export type CritterFrame = 'idle' | 'step' | 'blink';

const art = (rows: readonly string[], feetRow: number, feetStep: string): SpeciesArt => Object.freeze({ rows: Object.freeze([...rows]), feetRow, feetStep });

/** The letter rows of each species; an agent takes the species of its room. */
export const SPECIES: Readonly<Record<Species, SpeciesArt>> = Object.freeze({
  bun: art([
    '......oo........', '.....oaao.......', '......oao.......', '....oooooooo....',
    '...obbbbbbbbo...', '..obhhbbbbbbbo..', '.obhbbbbbbbbbbo.', '.obbwwbbbbwwbbo.',
    '.obbwpbbbbwpbbo.', '.obbbbbbbbbbbbo.', '.obbbbbbbbbbbbo.', '.osbbbbbbbbbbso.',
    '..osssssssssso..', '...oooooooooo...', '...oo......oo...', '................',
  ], 14, '....oo....oo....'),
  bot: art([
    '.......aa.......', '.......aa.......', '.......oo.......', '..oooooooooooo..',
    '..obbbbbbbbbbo..', '..obhhbbbbbbbo..', '.oobbbbbbbbbboo.', 'oabbwwbbbbwwbbao',
    'oabbwpbbbbwpbbao', '.oobbbbbbbbbboo.', '..obbbbbbbbbbo..', '..osbbbbbbbbso..',
    '..osssssssssso..', '..oooooooooooo..', '...oo......oo...', '................',
  ], 14, '....oo....oo....'),
  shield: art([
    '................', '..oooooooooooo..', '.obbbbbbbbbbbbo.', '.obhhbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.', '.obbwwbbbbwwbbo.', '.obbwpbbbbwpbbo.', '.obbbbbbbbbbbbo.',
    '.oaaaaaaaaaaaao.', '.obbbbbbbbbbbbo.', '..obbbbbbbbbbo..', '..osbbbbbbbbso..',
    '...osssssssso...', '....oooooooo....', '....oo....oo....', '................',
  ], 14, '.....oo..oo.....'),
  ghost: art([
    '..............y.', '....oooooooo.yyy', '...obbbbbbbbo.y.', '..obhhbbbbbbbo..',
    '.obhbbbbbbbbbbo.', '.obbwwbbbbwwbbo.', '.obbwpbbbbwpbbo.', '.obbbbbbbbbbbbo.',
    '.obbbbbbbbbbbbo.', '.obbbbbbbbbbbbo.', '.obbbbbbbbbbbbo.', '.osbbbbbbbbbbso.',
    '.osso.osso.osso.', '..oo...oo...oo..', '................', '................',
  ], -1, ''),
  cat: art([
    '................', '.oo..........oo.', '.oao........oao.', '.obao......oabo.',
    '.obboooooooobbo.', '.obhhbbbbbbbbbo.', '.obhbbbbbbbbbbo.', '.obbwwbbbbwwbbo.',
    '.obbwpbbbbwpbbo.', '.obbbbbaabbbbbo.', '.obbbbbbbbbbbbo.', '.osbbbbbbbbbbso.',
    '..osssssssssso..', '...oooooooooo...', '...oo......oo...', '................',
  ], 14, '....oo....oo....'),
  manager: art([
    '....oooooooooo....', '...obbbbbbbbbbo...', '..obhhbbbbbbbbbo..', '..obhbbbbbbbbbbo..',
    '..obbbbbbbbbbbbo..', '..obggggbbggggbo..', '..obgwwggggwwgbo..', '..obgwpgbbgwpgbo..',
    '..obggggbbggggbo..', '..obbbbbbbbbbbbo..', '..obbbkkbbkkbbbo..', '..obbbkkkkkkbbbo..',
    '..obbbkkbbkkbbbo..', '..obbbbbbbbbbbbo..', '..obbbbbbbbbbbbo..', '..osbbbbbbbbbbso..',
    '...osssssssssso...', '....oooooooooo....', '....oo......oo....', '..................',
  ], 18, '.....oo....oo.....'),
  mini: art(['..oooo..', '.obbbbo.', 'obwbbwbo', 'obbbbbbo', 'osbbbbso', '.oooooo.', '.o....o.', '........'], 6, '..o..o..'),
});

export const SPECIES_SIZE: Readonly<Record<Species, { readonly w: number; readonly h: number }>> = Object.freeze({
  bun: Object.freeze({ w: 16, h: 16 }),
  bot: Object.freeze({ w: 16, h: 16 }),
  shield: Object.freeze({ w: 16, h: 16 }),
  ghost: Object.freeze({ w: 16, h: 16 }),
  cat: Object.freeze({ w: 16, h: 16 }),
  manager: Object.freeze({ w: 18, h: 20 }),
  mini: Object.freeze({ w: 8, h: 8 }),
});

/** Closes the eyes: with two eye rows the whites go body-coloured and the pupils row becomes a line; with one, a line. */
const blinkRows = (rows: readonly string[]): readonly string[] => {
  const eyeRows = rows.flatMap((row, i) => (row.includes('w') ? [i] : []));
  const [first, second] = eyeRows;
  return rows.map((row, i) => {
    if (i === first) return second === undefined ? row.replace(/w/g, 'o') : row.replace(/w/g, 'b');
    if (i === second) return row.replace(/[wp]/g, 'o');
    return row;
  });
};

/** The letter rows of one animation frame. */
export function frameRows(species: Species, frame: CritterFrame): readonly string[] {
  const spec = SPECIES[species];
  if (frame === 'step' && spec.feetRow >= 0) return spec.rows.map((row, i) => (i === spec.feetRow ? spec.feetStep : row));
  if (frame === 'blink') return blinkRows(spec.rows);
  return spec.rows;
}
