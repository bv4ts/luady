import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HQ_PALETTE, type CritterFrame, type Species } from '@luady/office';
import { describe, expect, it, vi } from 'vitest';
import { cellOf, decodePng } from './png.js';

vi.mock('pixi.js', async () => (await import('./fake-pixi.js')).pixiModule);

const {
  ATLAS_COLUMNS, ATLAS_FRAMES, CELL_PX, KEY_COLUMN, LOOKS_PER_PAGE, PAGE_PX, atlasColumn, createCharacterAtlas, pyRound, recolour, shade,
} = await import('../../../../src/features/agency/scene/character-palette.js');
const { sheetBox } = await import('../../../../src/features/agency/scene/critter-box.js');

// Not `new URL(`...${name}`, import.meta.url)`: Vite rewrites that pattern into an asset lookup.
const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../src/features/agency/assets');
const assets = (name: string): string => resolve(ASSETS, name);
const atlas = decodePng(assets('characters.png'));
const frames = (JSON.parse(readFileSync(assets('characters.json'), 'utf8')) as { frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }> }).frames;

/** Every species of the shipped atlas: the room creatures, the manager, the helper and the two HQ staff. */
const ATLAS_SPECIES = ['bun', 'bot', 'shield', 'ghost', 'manager', 'mini', 'notetaker', 'mailclerk', 'cat'] as const;

const cell = (name: string): Uint8ClampedArray => {
  const f = frames[name]?.frame;
  if (f === undefined) throw new Error(`the atlas has no frame ${name}`);
  return cellOf(atlas, f.x, f.y, f.w, f.h);
};

describe('shade: the base, dark and light reds in a body colour', () => {
  it('rounds halves to the even neighbour, as Python does', () => {
    expect([0.5, 1.5, 2.5, 3.5, 2.4, 2.6, 254.5].map(pyRound)).toEqual([0, 2, 2, 4, 2, 3, 254]);
  });

  it('gives the base itself for R, and HQ key shades that differ from every other colour of the art', () => {
    expect(shade('#d6336c', 'R')).toEqual([214, 51, 108]);
    const key = (['R', 'D', 'L'] as const).map((role) => shade(HQ_PALETTE.base, role).join());
    expect(key).toEqual(['60,195,176', '44,143,129', '107,209,195']);
    expect(new Set([...key, '2,2,38', '252,251,251', '200,200,201']).size).toBe(6);
  });
});

describe('recolour: the golden test against the shipped atlas', () => {
  it('is 470 × 236 with 9 species × 6 palettes × 3 frames', () => {
    expect([atlas.width, atlas.height]).toEqual([470, 236]);
    expect(Object.keys(frames)).toHaveLength(ATLAS_SPECIES.length * Object.keys(ATLAS_COLUMNS).length * ATLAS_FRAMES.length);
  });

  it.each(Object.entries(ATLAS_COLUMNS))('rebuilds every %s frame from the key column, byte for byte', (column, base) => {
    let cells = 0;
    ATLAS_SPECIES.forEach((species) => ATLAS_FRAMES.forEach((frame) => {
      const got = recolour(cell(`${species}_${KEY_COLUMN}_${frame}`), base);
      expect(Buffer.from(got).equals(Buffer.from(cell(`${species}_${column}_${frame}`))), `${species} ${column} ${frame}`).toBe(true);
      cells += 1;
    }));
    expect(cells).toBe(27);
  });

  it('leaves the outline, white, grey and transparent pixels alone and paints the reds in any colour', () => {
    const key = cell(`shield_${KEY_COLUMN}_idle`);
    const out = recolour(key, '#3d7bff');
    const keyShades = (['R', 'D', 'L'] as const).map((role) => shade(HQ_PALETTE.base, role).join());
    const wanted = (['R', 'D', 'L'] as const).map((role) => shade('#3d7bff', role).join());
    let painted = 0;
    for (let i = 0; i < key.length; i += 4) {
      const was = `${key[i]},${key[i + 1]},${key[i + 2]}`;
      const now = `${out[i]},${out[i + 1]},${out[i + 2]}`;
      const role = keyShades.indexOf(was);
      if (role >= 0 && key[i + 3] !== 0) {
        expect(now).toBe(wanted[role]);
        painted += 1;
      } else {
        expect([now, out[i + 3]]).toEqual([was, key[i + 3]]);
      }
    }
    expect(painted).toBeGreaterThan(100);
    expect(out).not.toBe(key);
  });
});

describe('the shipped atlas and the sheet boxes', () => {
  it.each(['bun', 'bot', 'shield', 'ghost', 'cat', 'manager', 'mini'] as const)('measures the head row of %s from the atlas', (species: Species) => {
    Object.keys(ATLAS_COLUMNS).forEach((column) => ATLAS_FRAMES.forEach((frame) => {
      const c = cell(`${species}_${column}_${frame}`);
      const first = Array.from({ length: CELL_PX }, (_, y) => y).find((y) => Array.from({ length: CELL_PX }, (_, x) => c[(y * CELL_PX + x) * 4 + 3]).some((a) => a !== 0));
      expect(first).toBe(sheetBox(species).head);
    }));
  });

  it('keeps the cat bubble tail between its ears, above the line of its head and the eyes', () => {
    const c = cell(`cat_${KEY_COLUMN}_idle`);
    const opaque = (y: number): number => Array.from({ length: CELL_PX }, (_, x) => c[(y * CELL_PX + x) * 4 + 3]).filter((a) => a !== 0).length;
    const box = sheetBox('cat');
    expect(box).toEqual({ w: 24, h: 24, head: 1, tail: 3 });
    // Row 4 closes the head between the ears, so the row above it is the lowest the tail may rest on.
    expect(opaque(box.tail + 1)).toBeGreaterThan(opaque(box.tail));
  });

  it('names the atlas column of a body colour, whatever its case, and none for other colours', () => {
    expect(atlasColumn('#D6336C')).toBe('rose');
    expect(atlasColumn(HQ_PALETTE.base)).toBe(KEY_COLUMN);
    expect(atlasColumn('#3d7bff')).toBeNull();
  });
});

/** A page that records what was put where, standing in for a canvas page. */
const fakePages = () => {
  const made: { label: string; puts: { x: number; y: number; w: number; h: number }[]; updates: number; destroyed: boolean }[] = [];
  const makePage = (label: string) => {
    const page = { label, puts: [] as { x: number; y: number; w: number; h: number }[], updates: 0, destroyed: false };
    made.push(page);
    return {
      put: (_pixels: Uint8ClampedArray, x: number, y: number, w: number, h: number) => { page.puts.push({ x, y, w, h }); },
      texture: (x: number, y: number, w: number, h: number) => {
        const texture = { label: `${label}@${x},${y},${w}x${h}`, destroyed: false, destroy: () => { texture.destroyed = true; } };
        return texture as never;
      },
      update: () => { page.updates += 1; },
      destroy: () => { page.destroyed = true; },
    };
  };
  return { made, makePage };
};

const keys = { cell: (species: Species, frame: CritterFrame) => cell(`${species}_${KEY_COLUMN}_${frame}`) };
const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

describe('createCharacterAtlas: recoloured looks on 512-pixel pages', () => {
  it('packs three 24-pixel frames per look, 147 looks a page, and opens a second page after that', () => {
    const { made, makePage } = fakePages();
    const book = createCharacterAtlas(keys, makePage);
    const first = book.frame('bun', '#3d7bff', 'blink', 0) as unknown as { label: string };
    expect(first.label).toBe('characters:page-0@24,0,24x24');
    expect(book.frame('bun', '#3d7bff', 'blink', 0)).toBe(first);
    for (let i = 1; i < LOOKS_PER_PAGE; i += 1) book.frame('bot', hex(0x101010 + i), 'idle', 0);
    expect(made).toHaveLength(1);
    book.frame('cat', '#a78bfa', 'step', 0);
    expect(made).toHaveLength(2);
    made.flatMap((p) => p.puts).forEach((put) => {
      expect(put.x + put.w).toBeLessThanOrEqual(PAGE_PX);
      expect(put.y + put.h).toBeLessThanOrEqual(PAGE_PX);
    });
    expect(book.stats()).toEqual({ pages: 2, looks: LOOKS_PER_PAGE + 1, bytes: 2 * PAGE_PX * PAGE_PX * 4 });
  });

  it('uploads a page once per flush, however many looks were added', () => {
    const { made, makePage } = fakePages();
    const book = createCharacterAtlas(keys, makePage);
    ['#3d7bff', '#19b6d2', '#1f8fbf'].forEach((base) => book.frame('ghost', base, 'idle', 0));
    expect(made[0]?.updates).toBe(0);
    book.flush();
    book.flush();
    expect(made[0]?.updates).toBe(1);
  });

  it('frees looks nobody drew for two seconds and destroys the pages left empty', () => {
    const { made, makePage } = fakePages();
    const book = createCharacterAtlas(keys, makePage);
    const kept = book.frame('bun', '#3d7bff', 'idle', 0) as unknown as { destroyed: boolean };
    const gone = book.frame('bun', '#19b6d2', 'idle', 0) as unknown as { destroyed: boolean };
    book.frame('bun', '#3d7bff', 'idle', 1500);
    book.sweep(2100);
    expect([kept.destroyed, gone.destroyed]).toEqual([false, true]);
    expect(book.stats().looks).toBe(1);
    book.sweep(3600);
    expect(book.stats()).toEqual({ pages: 0, looks: 0, bytes: 0 });
    expect(made[0]?.destroyed).toBe(true);
  });

  it('draws nothing it cannot: no key cell, or no page', () => {
    const none = createCharacterAtlas({ cell: () => null }, fakePages().makePage);
    expect(none.frame('bun', '#3d7bff', 'idle', 0)).toBeNull();
    const noCanvas = createCharacterAtlas(keys, () => null);
    expect(noCanvas.frame('bun', '#3d7bff', 'idle', 0)).toBeNull();
    expect(noCanvas.stats().pages).toBe(0);
  });
});
