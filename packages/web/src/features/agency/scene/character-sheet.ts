import type { CritterFrame, Species } from '@luady/office';
import { ImageSource, Spritesheet, Texture, type SpritesheetData } from 'pixi.js';
// Vite gives the hashed, same-origin URL of the picture and bundles the frame list into this lazy chunk:
// nothing here needs a data: or blob: URL, a worker or eval, so it loads under the site's CSP (img-src 'self').
import sheetUrl from '../assets/characters.png';
import sheetData from '../assets/characters.json';
import { KEY_COLUMN, type KeyCells } from './character-palette.js';

/**
 * The generated character art: frames named `<species>_<column>_<frame>`, each 24 × 24 with the feet on the bottom
 * row, in six palette columns (character-palette.ts ATLAS_COLUMNS). The key column's pixels can be read for recolouring.
 */
export interface CharacterSheet extends KeyCells {
  /** The frame of a palette column, or null when the sheet has none (the code-drawn raster is used instead). */
  frame(species: Species, column: string, frame: CritterFrame): Texture | null;
  destroy(): void;
}

export type ImageLoader = (url: string) => Promise<HTMLImageElement>;

/** After this long without the picture the office opens with the code-drawn characters. */
export const SHEET_TIMEOUT_MS = 4000;

/** Loads a same-origin picture with a plain <img> (governed by img-src 'self'; no fetch, no worker). */
export const loadImage: ImageLoader = (url) => new Promise((resolve, reject) => {
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`could not load ${url}`));
  img.src = url;
});

/** The work's result, or null once `ms` passed first. The timer never outlives the race. */
const within = <T>(work: Promise<T>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

interface FrameRect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
const frameRects = (sheetData as unknown as { frames: Record<string, { frame: FrameRect }> }).frames;

/**
 * The key column's frames as RGBA, read once from the picture through a canvas (a same-origin picture, so the canvas
 * stays readable); an empty map when there is no 2D canvas.
 */
const readKeyCells = (img: HTMLImageElement): ReadonlyMap<string, Uint8ClampedArray> => {
  const cells = new Map<string, Uint8ClampedArray>();
  if (typeof document === 'undefined') return cells;
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || img.width;
  canvas.height = img.naturalHeight || img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) return cells;
  ctx.drawImage(img, 0, 0);
  Object.entries(frameRects).forEach(([name, { frame: f }]) => {
    if (name.split('_')[1] === KEY_COLUMN) cells.set(name, ctx.getImageData(f.x, f.y, f.w, f.h).data);
  });
  return cells;
};

const wrap = (sheet: Spritesheet, textures: Readonly<Record<string, Texture>>, img: HTMLImageElement | null): CharacterSheet => {
  let keys: ReadonlyMap<string, Uint8ClampedArray> | null = null;
  return {
    frame: (species, column, frame) => {
      const name = `${species}_${column}_${frame}`;
      return Object.hasOwn(textures, name) ? (textures[name] ?? null) : null;
    },
    cell: (species, frame) => {
      if (img === null) return null;
      keys ??= readKeyCells(img);
      return keys.get(`${species}_${KEY_COLUMN}_${frame}`) ?? null;
    },
    destroy: () => sheet.destroy(true),
  };
};

const build = async (img: HTMLImageElement): Promise<CharacterSheet> => {
  const source = new ImageSource({ resource: img, scaleMode: 'nearest', label: 'characters' });
  const texture = new Texture({ source, label: 'characters' });
  const sheet = new Spritesheet({ texture, data: sheetData as unknown as SpritesheetData });
  return wrap(sheet, await sheet.parse(), img);
};

/**
 * The character sheet, or null when it cannot be had (missing picture, broken data, too slow): the scene then
 * draws the code-made characters. Never rejects.
 */
export async function loadCharacterSheet(load: ImageLoader = loadImage): Promise<CharacterSheet | null> {
  try {
    const img = await within(load(sheetUrl), SHEET_TIMEOUT_MS);
    if (img === null) {
      console.warn('[agency] the character sheet took too long; using the drawn characters');
      return null;
    }
    return await build(img);
  } catch (error) {
    console.warn('[agency] could not load the character sheet; using the drawn characters', error);
    return null;
  }
}
