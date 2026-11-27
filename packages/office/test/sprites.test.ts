import { describe, expect, it } from 'vitest';
import { darken, hexToRgb, lighten } from '../src/colors.js';
import { pixelAt, type Raster } from '../src/raster.js';
import { bubbleRaster } from '../src/sprites/bubble.js';
import { critterRaster } from '../src/sprites/critter.js';
import { ICONS, dropRaster } from '../src/sprites/icons.js';
import { SPECIES, SPECIES_SIZE } from '../src/sprites/species.js';
import { paletteFor, HQ_PALETTE } from '../src/teams.js';
import type { Species } from '../src/types.js';
import { BUBBLE_ICONS } from '../src/visuals.js';
import { CLASSIC_PALETTES } from './rooms-fixture.js';

const ALL_SPECIES: readonly Species[] = ['bun', 'bot', 'shield', 'ghost', 'cat', 'manager', 'mini'];
const WHITE = [255, 255, 255, 255];

const rowsThatDiffer = (a: Raster, b: Raster): readonly number[] =>
  Array.from({ length: a.height }, (_, y) => y).filter((y) =>
    Array.from({ length: a.width }, (_, x) => x).some((x) => pixelAt(a, x, y).join() !== pixelAt(b, x, y).join()));

const count = (r: Raster, colour: string): number => {
  const [cr, cg, cb] = hexToRgb(colour);
  let n = 0;
  for (let i = 0; i < r.data.length; i += 4) if (r.data[i] === cr && r.data[i + 1] === cg && r.data[i + 2] === cb && r.data[i + 3] === 255) n += 1;
  return n;
};

const hasWhite = (r: Raster): boolean => count(r, '#ffffff') > 0;

describe('critterRaster', () => {
  it('draws the Orchard bun from its letter rows', () => {
    const bun = critterRaster('bun', CLASSIC_PALETTES.rose, 'idle');
    expect([bun.width, bun.height]).toEqual([16, 16]);
    expect(pixelAt(bun, 4, 4)).toEqual([214, 51, 108, 255]);
    expect(pixelAt(bun, 0, 0)[3]).toBe(0);
    expect(pixelAt(bun, 4, 7)).toEqual(WHITE);
  });

  it('moves only the feet row on the step frame', () => {
    expect(rowsThatDiffer(critterRaster('bun', CLASSIC_PALETTES.rose, 'idle'), critterRaster('bun', CLASSIC_PALETTES.rose, 'step'))).toEqual([14]);
    expect(rowsThatDiffer(critterRaster('manager', HQ_PALETTE, 'idle'), critterRaster('manager', HQ_PALETTE, 'step'))).toEqual([18]);
  });

  it('draws the cat with both ears up and moves only its feet on the step frame', () => {
    const cat = critterRaster('cat', CLASSIC_PALETTES.rose, 'idle');
    expect([pixelAt(cat, 1, 1)[3], pixelAt(cat, 14, 1)[3], pixelAt(cat, 7, 1)[3]]).toEqual([255, 255, 0]);
    expect(pixelAt(cat, 2, 2)).toEqual([...hexToRgb(paletteFor(CLASSIC_PALETTES.rose).a), 255]);
    expect(rowsThatDiffer(cat, critterRaster('cat', CLASSIC_PALETTES.rose, 'step'))).toEqual([14]);
  });

  it('keeps a ghost still on the step frame (it floats)', () => {
    expect(rowsThatDiffer(critterRaster('ghost', CLASSIC_PALETTES.pv, 'idle'), critterRaster('ghost', CLASSIC_PALETTES.pv, 'step'))).toEqual([]);
  });

  it.each(ALL_SPECIES)('closes the eyes of %s on the blink frame', (species) => {
    expect(hasWhite(critterRaster(species, CLASSIC_PALETTES.rose, 'idle'))).toBe(true);
    expect(hasWhite(critterRaster(species, CLASSIC_PALETTES.rose, 'blink'))).toBe(false);
  });

  it.each(ALL_SPECIES)('sizes %s as SPECIES_SIZE says', (species) => {
    const r = critterRaster(species, HQ_PALETTE, 'idle');
    expect({ w: r.width, h: r.height }).toEqual(SPECIES_SIZE[species]);
    expect(SPECIES[species].rows).toHaveLength(SPECIES_SIZE[species].h);
  });

  it('has the species sizes', () => {
    expect(SPECIES_SIZE).toEqual({
      bun: { w: 16, h: 16 }, bot: { w: 16, h: 16 }, shield: { w: 16, h: 16 }, ghost: { w: 16, h: 16 }, cat: { w: 16, h: 16 },
      manager: { w: 18, h: 20 }, mini: { w: 8, h: 8 },
    });
    expect([critterRaster('manager', HQ_PALETTE, 'idle').width, critterRaster('manager', HQ_PALETTE, 'idle').height]).toEqual([18, 20]);
    expect([critterRaster('mini', CLASSIC_PALETTES.rose, 'idle').width, critterRaster('mini', CLASSIC_PALETTES.rose, 'idle').height]).toEqual([8, 8]);
  });

  it('changes only the accent pixels between variants', () => {
    const plain = critterRaster('bun', CLASSIC_PALETTES.rose, 'idle', 0);
    const gold = critterRaster('bun', CLASSIC_PALETTES.rose, 'idle', 3);
    const accent = paletteFor(CLASSIC_PALETTES.rose).a;
    const accentPixels = count(plain, accent);
    expect(accentPixels).toBeGreaterThan(0);
    expect(count(gold, accent)).toBe(0);
    expect(count(gold, '#ffd84d')).toBe(accentPixels);
    for (let y = 0; y < 16; y += 1) {
      for (let x = 0; x < 16; x += 1) {
        const same = pixelAt(plain, x, y).join() === pixelAt(gold, x, y).join();
        const isAccent = pixelAt(plain, x, y).slice(0, 3).join() === hexToRgb(accent).join();
        expect(same || isAccent).toBe(true);
      }
    }
  });

  it('gives each of the six variants its own accent', () => {
    const accents = [0, 1, 2, 3, 4, 5].map((v) => {
      const r = critterRaster('bot', CLASSIC_PALETTES.amber, 'idle', v);
      return pixelAt(r, 7, 0).join();
    });
    expect(new Set(accents).size).toBe(6);
  });

  it('recolours the star of a ghost (it has no accent) with the same five variant colours', () => {
    const star = '#ffd84d';
    const expected = [star, lighten(star, 0.35), darken(star, 0.3), '#ffd84d', '#e9eef7', '#5aa2ff'];
    const ghosts = [0, 1, 2, 3, 4, 5].map((v) => critterRaster('ghost', CLASSIC_PALETTES.pv, 'idle', v));
    expect(ghosts.map((r) => pixelAt(r, 14, 0).join())).toEqual(expected.map((c) => [...hexToRgb(c), 255].join()));
    const starPixels = count(ghosts[0]!, star);
    expect(starPixels).toBe(5);
    ghosts.forEach((r, v) => {
      expect(count(r, expected[v]!)).toBe(starPixels);
      for (let y = 0; y < 16; y += 1) {
        for (let x = 0; x < 16; x += 1) {
          const isStar = SPECIES.ghost.rows[y]?.[x] === 'y';
          if (!isStar) expect(pixelAt(r, x, y).join()).toBe(pixelAt(ghosts[0]!, x, y).join());
        }
      }
    });
    expect(new Set(ghosts.map((r) => pixelAt(r, 14, 0).join())).size).toBe(5);
  });

  it.each(['manager', 'mini'] as const)('keeps %s single-look: it has neither an accent nor a star', (species) => {
    const plain = critterRaster(species, HQ_PALETTE, 'idle', 0);
    [1, 2, 3, 4, 5].forEach((v) => expect(critterRaster(species, HQ_PALETTE, 'idle', v).data).toEqual(plain.data));
  });

  it('wraps a variant outside 0..5 and treats nonsense as 0', () => {
    expect(critterRaster('bot', CLASSIC_PALETTES.amber, 'idle', 9).data).toEqual(critterRaster('bot', CLASSIC_PALETTES.amber, 'idle', 3).data);
    expect(critterRaster('bot', CLASSIC_PALETTES.amber, 'idle', -1).data).toEqual(critterRaster('bot', CLASSIC_PALETTES.amber, 'idle', 5).data);
    expect(critterRaster('bot', CLASSIC_PALETTES.amber, 'idle', Number.NaN).data).toEqual(critterRaster('bot', CLASSIC_PALETTES.amber, 'idle').data);
  });
});

describe('bubbleRaster', () => {
  const drawnColour = (icon: keyof typeof ICONS): string => (icon === 'bang' || icon === 'key' ? '#ffffff' : ICONS[icon].color);
  const marks = (icon: keyof typeof ICONS): number => ICONS[icon].rows.join('').split('').filter((c) => c === 'x').length;

  it('has an icon pattern for every bubble icon', () => {
    expect(Object.keys(ICONS).sort()).toEqual([...BUBBLE_ICONS].sort());
    BUBBLE_ICONS.forEach((icon) => {
      expect(ICONS[icon].rows).toHaveLength(7);
      expect(ICONS[icon].rows.every((row) => row.length === 7)).toBe(true);
    });
  });

  it.each(BUBBLE_ICONS)('draws %s as a 13 x 15 bubble with its icon in it', (icon) => {
    const r = bubbleRaster(icon);
    expect([r.width, r.height]).toEqual([13, 15]);
    expect(count(r, drawnColour(icon))).toBe(marks(icon));
    expect(count(r, drawnColour(icon))).toBeGreaterThanOrEqual(icon === 'dots' ? 3 : 5);
  });

  it('fills bang and key bubbles red and the rest white', () => {
    expect(pixelAt(bubbleRaster('bang'), 6, 6)).toEqual([226, 58, 46, 255]);
    expect(pixelAt(bubbleRaster('key'), 1, 1)).toEqual([226, 58, 46, 255]);
    expect(pixelAt(bubbleRaster('book'), 1, 1)).toEqual(WHITE);
  });

  it('uses the expected colours for the key, globe, skill and ask icons', () => {
    expect([ICONS.key.color, ICONS.globe.color, ICONS.skill.color, ICONS.ask.color]).toEqual(['#b88600', '#2f6fe0', '#7c5cff', '#c77a00']);
  });

  it('draws the outline and the tail', () => {
    const r = bubbleRaster('dots');
    expect(pixelAt(r, 0, 0)[3]).toBe(0);
    expect(pixelAt(r, 0, 1)).toEqual([16, 20, 29, 255]);
    expect(pixelAt(r, 6, 14)).toEqual([16, 20, 29, 255]);
    expect(pixelAt(r, 5, 14)[3]).toBe(0);
  });
});

describe('dropRaster', () => {
  it('is a 5 × 7 blue drop', () => {
    const drop = dropRaster();
    expect([drop.width, drop.height]).toEqual([5, 7]);
    let opaque = 0;
    for (let i = 3; i < drop.data.length; i += 4) if (drop.data[i] === 255) opaque += 1;
    expect(opaque).toBeGreaterThanOrEqual(10);
    const [r, g, b] = pixelAt(drop, 2, 4);
    expect(b).toBeGreaterThan(r);
    expect(b).toBeGreaterThan(g);
  });
});
