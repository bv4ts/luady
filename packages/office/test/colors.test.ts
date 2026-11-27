import { describe, expect, it } from 'vitest';
import { darken, hexToRgb, lighten, mix } from '../src/colors.js';
import { buildOffice } from '../src/layout.js';
import { paletteFor, HQ_PALETTE, MUTE_PALETTE } from '../src/teams.js';
import { TILE } from '../src/types.js';
import { CLASSIC_PALETTES, CLASSIC_ROOMS } from './rooms-fixture.js';

describe('map constants', () => {
  it('uses 16-pixel tiles; the classic four make an 84 x 42 grid', () => {
    const map = buildOffice(CLASSIC_ROOMS);
    expect([TILE, map.width / TILE, map.height / TILE]).toEqual([16, 84, 42]);
  });
});

describe('hexToRgb', () => {
  it('reads #rrggbb into three channels', () => {
    expect(hexToRgb('#d6336c')).toEqual([214, 51, 108]);
  });

  it('rejects anything that is not #rrggbb', () => {
    expect(() => hexToRgb('#fff')).toThrow(RangeError);
    expect(() => hexToRgb('red')).toThrow(RangeError);
  });
});

describe('mix', () => {
  it('blends half way, rounding to the nearest channel value', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('clamps t to 0..1', () => {
    expect(mix('#102030', '#ffffff', -1)).toBe('#102030');
    expect(mix('#102030', '#ffffff', 2)).toBe('#ffffff');
  });

  it('treats a NaN t as 0', () => {
    expect(mix('#102030', '#ffffff', Number.NaN)).toBe('#102030');
  });
});

describe('lighten and darken', () => {
  it('darken mixes towards the night colour', () => {
    expect(darken('#d6336c', 0.3)).toBe(mix('#d6336c', '#080b14', 0.3));
  });

  it('lighten mixes towards white', () => {
    expect(lighten('#d6336c', 0.42)).toBe(mix('#d6336c', '#ffffff', 0.42));
  });
});

describe('the palettes', () => {
  it('carries the fixed brand colours of the rooms, HQ and the muted grey', () => {
    expect(CLASSIC_PALETTES.rose.base).toBe('#d6336c');
    expect(CLASSIC_PALETTES.amber.base).toBe('#f76707');
    expect(CLASSIC_PALETTES.jade.base).toBe('#12b886');
    expect(CLASSIC_PALETTES.pv.base).toBe('#7c5cff');
    expect(HQ_PALETTE.base).toBe('#3cc3b0');
    expect(MUTE_PALETTE.base).toBe('#6c7689');
  });
});

describe('paletteFor', () => {
  it('maps the sprite letters to colours', () => {
    const pal = paletteFor(CLASSIC_PALETTES.rose);
    expect(pal.b).toBe('#d6336c');
    expect(pal.w).toBe('#ffffff');
    expect(pal.a).toBe('#74b816');
    expect(pal.o).toBe(darken('#d6336c', 0.78));
    expect(pal.s).toBe(darken('#d6336c', 0.3));
    expect(pal.h).toBe(lighten('#d6336c', 0.42));
    expect([pal.p, pal.k, pal.g, pal.y]).toEqual(['#141a26', '#10141d', '#10141d', '#ffd84d']);
  });

  it('returns a frozen palette', () => {
    expect(Object.isFrozen(paletteFor(HQ_PALETTE))).toBe(true);
  });
});
