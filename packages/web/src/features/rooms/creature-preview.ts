import type { RoomSpecies } from '@luady/shared';

/** One creature cell is 24 × 24 pixels (the art's size). */
export const CREATURE_PX = 24;

type Sheet = { cell(species: RoomSpecies, frame: 'idle'): Uint8ClampedArray | null };
type Recolour = (key: Uint8ClampedArray, base: string) => Uint8ClampedArray;

let loading: Promise<{ readonly sheet: Sheet | null; readonly recolour: Recolour } | null> | null = null;

/**
 * The character sheet and the recolour, loaded once and only when a preview is first drawn (the scene's code stays out
 * of the settings page until then). Null when the sheet cannot be had.
 */
function art() {
  loading ??= Promise.all([import('../agency/scene/character-sheet.js'), import('../agency/scene/character-palette.js')])
    .then(async ([sheetModule, palette]) => ({ sheet: await sheetModule.loadCharacterSheet(), recolour: palette.recolour }))
    .catch((err: unknown) => {
      console.warn('[rooms] the creature preview could not load', err);
      return null;
    });
  return loading;
}

/**
 * Draws a room creature in its colour into a 24 × 24 canvas: the key frame of the sheet, recoloured exactly as the map
 * does. Resolves false when there is nothing to draw (no sheet, no 2D canvas).
 */
export async function drawCreature(canvas: HTMLCanvasElement, species: RoomSpecies, base: string): Promise<boolean> {
  const loaded = await art();
  const key = loaded?.sheet?.cell(species, 'idle') ?? null;
  const ctx = canvas.getContext('2d');
  if (loaded === null || key === null || ctx === null) return false;
  canvas.width = CREATURE_PX;
  canvas.height = CREATURE_PX;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(loaded.recolour(key, base)), CREATURE_PX, CREATURE_PX), 0, 0);
  return true;
}
