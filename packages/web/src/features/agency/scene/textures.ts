import {
  bubbleRaster, critterRaster, dropRaster, furnitureRaster, glowPoolRaster, groundRaster, monitorScreen, ringRaster, sparkleRaster,
  type BubbleIcon, type CritterFrame, type FurnitureKind, type MonitorGlow, type Palette, type Raster, type RingHalf, type Species,
} from '@luady/office';
import { BufferImageSource, Texture } from 'pixi.js';
import { atlasColumn, canvasPage, createCharacterAtlas, type CharacterAtlas, type PageFactory } from './character-palette.js';
import type { CharacterSheet } from './character-sheet.js';
import { drawnBox, sheetBox, type CritterBox } from './critter-box.js';

/**
 * GPU textures for the office's small pictures: one texture per distinct raster, made on first use and kept, keyed
 * by colour (hex), never by team. The map-sized pictures are chunks (chunk-bank.ts): nothing here is larger than the
 * 64-pixel grass tile.
 */
export interface TextureBank {
  /**
   * A character frame in a room's colours: the shipped sheet's frame when the sheet has that colour, else the sheet's
   * key frame recoloured (no look variants on the sheet), else the code-drawn raster.
   */
  critter(species: Species, palette: Palette, frame: CritterFrame, variant: number): Texture;
  /** How the pictures `critter` gives for this look sit on their feet. */
  critterBox(species: Species, palette: Palette): CritterBox;
  bubble(icon: BubbleIcon): Texture;
  /** The sweat drop beside an agent whose context is nearly full. */
  drop(): Texture;
  /** One half of the ring round a working character (white: tint it). */
  ring(half: RingHalf): Texture;
  /** One frame of the sparkle round a session Luady just started. */
  sparkle(frame: number): Texture;
  furniture(kind: FurnitureKind): Texture;
  monitor(glow: MonitorGlow, palette: Palette): Texture;
  /** The repeating grass tile (64 × 64). */
  ground(): Texture;
  /** A soft pool of light with half-axes rx × ry (white: tint it). */
  glowPool(rx: number, ry: number): Texture;
  /** Once per frame, before drawing: uploads new recoloured looks and frees the ones no longer drawn. */
  frameEnd(nowMs: number): void;
  /** Every texture here, and their GPU bytes. */
  stats(): { readonly textures: number; readonly bytes: number };
  destroy(): void;
}

/**
 * Uploads a raster as is. The view shares the raster's memory (no copy) and PixiJS only reads it, so the
 * raster stays untouched, as @luady/office requires.
 */
export function textureFromRaster(raster: Raster, label: string): Texture {
  const pixels = new Uint8Array(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength);
  const source = new BufferImageSource({
    resource: pixels, width: raster.width, height: raster.height, format: 'rgba8unorm', scaleMode: 'nearest', label,
  });
  return new Texture({ source, label });
}

/** The atlas picture the sheet loads from: 470 × 236. */
const SHEET_BYTES = 470 * 236 * 4;
/** How often unused recoloured looks are swept. */
const SWEEP_MS = 1000;

interface Pick { readonly texture: Texture; readonly fromSheet: boolean }

export interface TextureBankOptions {
  /** Where recoloured looks are drawn (canvas pages by default). */
  readonly pages?: PageFactory;
  /** ms; performance.now by default. */
  readonly clock?: () => number;
}

/**
 * The textures of one scene. `sheet` (the generated characters) is used and destroyed by the bank; without it, or
 * for a look it lacks, characters are drawn from the office rasters.
 */
export function createTextureBank(sheet: CharacterSheet | null = null, options: TextureBankOptions = {}): TextureBank {
  const clock = options.clock ?? (() => performance.now());
  const cache = new Map<string, Texture>();
  let bytes = 0;
  let atlas: CharacterAtlas | null = null;
  let sweptAt = 0;

  const cached = (key: string, make: () => Raster): Texture => {
    const known = cache.get(key);
    if (known !== undefined) return known;
    const raster = make();
    const texture = textureFromRaster(raster, key);
    cache.set(key, texture);
    bytes += raster.width * raster.height * 4;
    return texture;
  };

  const atlasOf = (): CharacterAtlas | null => {
    if (sheet === null) return null;
    atlas ??= createCharacterAtlas(sheet, options.pages ?? canvasPage);
    return atlas;
  };

  /** The sheet's frame for this colour, else the recoloured key frame; null when neither can be had. */
  const fromSheet = (species: Species, palette: Palette, frame: CritterFrame): Pick | null => {
    if (sheet === null) return null;
    const column = atlasColumn(palette.base);
    const shipped = column === null ? null : sheet.frame(species, column, frame);
    if (shipped !== null) return { texture: shipped, fromSheet: true };
    const painted = atlasOf()?.frame(species, palette.base, frame, clock()) ?? null;
    return painted === null ? null : { texture: painted, fromSheet: true };
  };

  const drawn = (species: Species, palette: Palette, frame: CritterFrame, variant: number): Texture =>
    cached(`critter:${species}:${palette.base}${palette.accent}:${frame}:${variant}`, () => critterRaster(species, palette, frame, variant));

  return {
    critter: (species, palette, frame, variant) => fromSheet(species, palette, frame)?.texture ?? drawn(species, palette, frame, variant),
    critterBox: (species, palette) => (fromSheet(species, palette, 'idle') !== null ? sheetBox(species) : drawnBox(species)),
    bubble: (icon) => cached(`bubble:${icon}`, () => bubbleRaster(icon)),
    drop: () => cached('drop', dropRaster),
    ring: (half) => cached(`ring:${half}`, () => ringRaster(half)),
    sparkle: (frame) => cached(`sparkle:${frame}`, () => sparkleRaster(frame)),
    furniture: (kind) => cached(`furniture:${kind}`, () => furnitureRaster(kind)),
    monitor: (glow, palette) => cached(`monitor:${glow}:${palette.base}`, () => monitorScreen(glow, palette)),
    ground: () => cached('ground', groundRaster),
    glowPool: (rx, ry) => cached(`pool:${rx}x${ry}`, () => glowPoolRaster(rx, ry)),
    frameEnd: (nowMs) => {
      if (atlas === null) return;
      atlas.flush();
      if (nowMs - sweptAt < SWEEP_MS) return;
      sweptAt = nowMs;
      atlas.sweep(nowMs);
    },
    stats: () => {
      const pages = atlas?.stats() ?? { pages: 0, bytes: 0 };
      return Object.freeze({ textures: cache.size + pages.pages + (sheet === null ? 0 : 1), bytes: bytes + pages.bytes + (sheet === null ? 0 : SHEET_BYTES) });
    },
    destroy: () => {
      atlas?.destroy();
      atlas = null;
      sheet?.destroy();
      cache.forEach((texture) => texture.destroy(true));
      cache.clear();
      bytes = 0;
    },
  };
}
