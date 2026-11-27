import { HQ_ID, HQ_PALETTE, MUTE_PALETTE, type CritterFrame, type Species } from '@luady/office';
import { CanvasSource, Rectangle, Texture } from 'pixi.js';

/**
 * Creatures in any room colour at run time. The shipped atlas holds every species in
 * six palettes; its HQ column is a lossless key, because each of the art's three reds became one fixed shade of HQ's
 * colour. A frame in any other body colour is that key frame with exactly those three shades replaced: no tint, no
 * filter, and the navy outline, the white and grey and the transparent pixels stay as drawn. Recoloured frames go
 * onto 512-pixel canvas pages (no data: or blob: URL, no worker), made only for the looks the scene draws.
 */

export type ShadeRole = 'R' | 'D' | 'L';
export type Rgb = readonly [number, number, number];

/** The three reds of the character art: the base, the dark and the light red. */
export const KEY_REDS: Readonly<Record<ShadeRole, Rgb>> = Object.freeze({ R: [241, 20, 37], D: [187, 4, 17], L: [250, 71, 83] });

/** Python's round(): a half goes to the even neighbour. */
export function pyRound(x: number): number {
  const floor = Math.floor(x);
  const rest = x - floor;
  if (rest > 0.5) return floor + 1;
  if (rest < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** HLS lightness of a colour, as Python's colorsys computes it. */
const lightness = ([r, g, b]: Rgb): number => (Math.max(r / 255, g / 255, b / 255) + Math.min(r / 255, g / 255, b / 255)) / 2;

const L_BASE = lightness(KEY_REDS.R);
const DARK_K = lightness(KEY_REDS.D) / L_BASE;
const LIGHT_T = (lightness(KEY_REDS.L) - L_BASE) / (1 - L_BASE);

const rgbOf = (hex: string): Rgb => {
  const n = Number.parseInt(hex.replace(/^#/, ''), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
};

/**
 * One of the art's three reds in a body colour. R is the base itself;
 * D scales each channel by the dark red's lightness over the base red's; L moves each channel toward white by the
 * light red's share of the lightness left above the base red.
 */
export function shade(base: string, role: ShadeRole): Rgb {
  const rgb = rgbOf(base);
  if (role === 'R') return rgb;
  if (role === 'D') return [pyRound(rgb[0] * DARK_K), pyRound(rgb[1] * DARK_K), pyRound(rgb[2] * DARK_K)];
  const up = (v: number): number => pyRound(v + (255 - v) * LIGHT_T);
  return [up(rgb[0]), up(rgb[1]), up(rgb[2])];
}

/** The body colour of each palette the shipped atlas was drawn in, by its column name in characters.json. */
export const ATLAS_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  rose: '#d6336c', amber: '#f76707', jade: '#12b886', pv: '#7c5cff', [HQ_ID]: HQ_PALETTE.base, mute: MUTE_PALETTE.base,
});

/** The key column: every frame there is in HQ's colours, whose three shades map one to one onto the three reds. */
export const KEY_COLUMN: string = HQ_ID;

const COLUMN_OF: ReadonlyMap<string, string> = new Map(Object.entries(ATLAS_COLUMNS).map(([column, base]) => [base.toLowerCase(), column]));

/** The atlas column drawn in this body colour, or null when the atlas has none (the frame is recoloured). */
export function atlasColumn(base: string): string | null {
  return COLUMN_OF.get(base.toLowerCase()) ?? null;
}

const ROLES: readonly ShadeRole[] = ['R', 'D', 'L'];
const KEY_SHADES: readonly Rgb[] = ROLES.map((role) => shade(HQ_PALETTE.base, role));

/**
 * A key frame (RGBA, from the key column) in another body colour: every pixel in one of the key's three shades becomes
 * that shade of `base`; every other pixel is copied as it is. Returns a new array.
 */
export function recolour(key: Uint8ClampedArray, base: string): Uint8ClampedArray {
  const to = ROLES.map((role) => shade(base, role));
  const out = new Uint8ClampedArray(key);
  for (let i = 0; i < out.length; i += 4) {
    if (out[i + 3] === 0) continue;
    const role = KEY_SHADES.findIndex((k) => k[0] === out[i] && k[1] === out[i + 1] && k[2] === out[i + 2]);
    const rgb = role < 0 ? undefined : to[role];
    if (rgb !== undefined) out.set(rgb, i);
  }
  return out;
}

/** The frames of a look, in their order on a page. */
export const ATLAS_FRAMES: readonly CritterFrame[] = Object.freeze(['idle', 'blink', 'step'] as const);
/** Every atlas frame is 24 × 24; a page is at most 512 × 512. */
export const CELL_PX = 24;
export const PAGE_PX = 512;
const LOOK_W = CELL_PX * ATLAS_FRAMES.length;
const LOOKS_PER_ROW = Math.floor(PAGE_PX / LOOK_W);
/** Looks (one species in one colour, three frames) on one page. */
export const LOOKS_PER_PAGE = LOOKS_PER_ROW * Math.floor(PAGE_PX / CELL_PX);
/** A look nobody drew for this long is freed; a page left with no looks is destroyed. */
export const LOOK_RELEASE_MS = 2000;

/** The key frames, read from the loaded sheet: null when the sheet or its pixels cannot be had. */
export interface KeyCells {
  cell(species: Species, frame: CritterFrame): Uint8ClampedArray | null;
}

/** One page: a 512-pixel surface the atlas writes cells into, with sub-textures over it. */
export interface AtlasPage {
  put(pixels: Uint8ClampedArray, x: number, y: number, w: number, h: number): void;
  texture(x: number, y: number, w: number, h: number): Texture;
  /** Uploads what was put since the last update. */
  update(): void;
  destroy(): void;
}

/** Makes a page, or null when there is no canvas to draw on (no recolouring then: the drawn creatures are used). */
export type PageFactory = (label: string) => AtlasPage | null;

export interface CharacterAtlas {
  /** The frame of a look in a body colour (`now`: ms, marks the look as drawn). Null when it cannot be made. */
  frame(species: Species, base: string, frame: CritterFrame, now: number): Texture | null;
  /** Uploads the pages that got new looks. Call once per frame, before drawing. */
  flush(): void;
  /** Frees the looks not drawn for LOOK_RELEASE_MS and destroys pages left empty. */
  sweep(now: number): void;
  stats(): { readonly pages: number; readonly looks: number; readonly bytes: number };
  destroy(): void;
}

interface Page { readonly surface: AtlasPage; readonly used: (string | null)[]; dirty: boolean }
interface Look { readonly page: Page; readonly slot: number; readonly textures: readonly Texture[]; lastUsed: number }

const lookKey = (species: Species, base: string): string => `${species}:${base.toLowerCase()}`;

/** Recoloured looks on as few pages as they need; a look gets the first free slot of a page that has one. */
export function createCharacterAtlas(keys: KeyCells, makePage: PageFactory): CharacterAtlas {
  const pages: Page[] = [];
  const looks = new Map<string, Look>();
  let noCanvas = false;

  const freeSlot = (): { page: Page; slot: number } | null => {
    for (const page of pages) {
      const slot = page.used.indexOf(null);
      if (slot >= 0) return { page, slot };
    }
    if (noCanvas) return null;
    const surface = makePage(`characters:page-${pages.length}`);
    if (surface === null) {
      noCanvas = true;
      return null;
    }
    const page: Page = { surface, used: Array.from({ length: LOOKS_PER_PAGE }, () => null), dirty: false };
    pages.push(page);
    return { page, slot: 0 };
  };

  const make = (species: Species, base: string, key: string, now: number): Look | null => {
    const cells = ATLAS_FRAMES.map((f) => keys.cell(species, f));
    if (cells.some((c) => c === null || c.length !== CELL_PX * CELL_PX * 4)) return null;
    const at = freeSlot();
    if (at === null) return null;
    const x0 = (at.slot % LOOKS_PER_ROW) * LOOK_W;
    const y0 = Math.floor(at.slot / LOOKS_PER_ROW) * CELL_PX;
    const textures = cells.map((c, i) => {
      at.page.surface.put(recolour(c as Uint8ClampedArray, base), x0 + i * CELL_PX, y0, CELL_PX, CELL_PX);
      return at.page.surface.texture(x0 + i * CELL_PX, y0, CELL_PX, CELL_PX);
    });
    at.page.used[at.slot] = key;
    at.page.dirty = true;
    const look: Look = { page: at.page, slot: at.slot, textures, lastUsed: now };
    looks.set(key, look);
    return look;
  };

  const free = (key: string, look: Look): void => {
    look.textures.forEach((t) => t.destroy());
    look.page.used[look.slot] = null;
    looks.delete(key);
  };

  return {
    frame: (species, base, frame, now) => {
      const key = lookKey(species, base);
      const look = looks.get(key) ?? make(species, base, key, now);
      if (look === null) return null;
      look.lastUsed = Math.max(look.lastUsed, now);
      return look.textures[ATLAS_FRAMES.indexOf(frame)] ?? look.textures[0] ?? null;
    },
    flush: () => {
      pages.forEach((page) => {
        if (!page.dirty) return;
        page.dirty = false;
        page.surface.update();
      });
    },
    sweep: (now) => {
      looks.forEach((look, key) => { if (now - look.lastUsed > LOOK_RELEASE_MS) free(key, look); });
      for (let i = pages.length - 1; i >= 0; i -= 1) {
        const page = pages[i];
        if (page === undefined || page.used.some((k) => k !== null)) continue;
        page.surface.destroy();
        pages.splice(i, 1);
      }
    },
    stats: () => Object.freeze({ pages: pages.length, looks: looks.size, bytes: pages.length * PAGE_PX * PAGE_PX * 4 }),
    destroy: () => {
      looks.forEach((look, key) => free(key, look));
      pages.forEach((p) => p.surface.destroy());
      pages.length = 0;
    },
  };
}

/** A page on a canvas, uploaded as a nearest-scaled CanvasSource; null without a 2D context (jsdom, a refused canvas). */
export const canvasPage: PageFactory = (label) => {
  if (typeof document === 'undefined' || typeof ImageData === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = PAGE_PX;
  canvas.height = PAGE_PX;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  const source = new CanvasSource({ resource: canvas, scaleMode: 'nearest', label });
  return {
    put: (pixels, x, y, w, h) => ctx.putImageData(new ImageData(new Uint8ClampedArray(pixels), w, h), x, y),
    texture: (x, y, w, h) => new Texture({ source, frame: new Rectangle(x, y, w, h), label }),
    update: () => source.update(),
    destroy: () => source.destroy(),
  };
};
