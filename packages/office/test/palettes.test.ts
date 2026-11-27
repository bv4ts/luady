import { describe, expect, it } from 'vitest';
import { critterRaster } from '../src/sprites/critter.js';
import { HQ_PALETTE, MUTE_PALETTE, paletteFor } from '../src/teams.js';
import { CLASSIC_PALETTES } from './rooms-fixture.js';

const PALETTES = [...Object.values(CLASSIC_PALETTES), HQ_PALETTE, MUTE_PALETTE];

describe('fixed palettes', () => {
  it('are the HQ and grey families', () => {
    expect(HQ_PALETTE).toEqual({ base: '#3cc3b0', accent: '#ffd84d' });
    expect(MUTE_PALETTE).toEqual({ base: '#6c7689', accent: '#8a93a5' });
    expect(Object.isFrozen(HQ_PALETTE) && Object.isFrozen(MUTE_PALETTE)).toBe(true);
  });
});

describe('paletteFor', () => {
  it('reads only the base and accent', () => {
    PALETTES.forEach((palette) => expect(paletteFor({ base: palette.base, accent: palette.accent })).toEqual(paletteFor(palette)));
  });

  it('colours any room', () => {
    const pal = paletteFor({ base: '#3d7bff', accent: '#9fbdff' });
    expect(pal.b).toBe('#3d7bff');
    expect(pal.a).toBe('#9fbdff');
  });
});

describe('critterRaster with a palette', () => {
  it('draws a room colour no classic room has', () => {
    const blue = critterRaster('bun', { base: '#3d7bff', accent: '#9fbdff' }, 'idle', 0);
    expect(blue.data).not.toEqual(critterRaster('bun', CLASSIC_PALETTES.rose, 'idle', 0).data);
  });
});

