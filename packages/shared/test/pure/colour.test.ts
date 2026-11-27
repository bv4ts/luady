import { describe, expect, it } from 'vitest';
import {
  BODY_LUMINANCE, DEFAULT_ROOM_PALETTE, RESERVED_COLOURS, clampBody, defaultAccent, deltaE2000, nearReserved, normaliseHex,
  relativeLuminance,
} from '../../src/pure/colour.js';

/** The classic jade room colour (office/src/teams.ts). */
const JADE = '#12b886';

describe('colour basics', () => {
  it('normalises #rgb, upper case and a missing #; refuses anything else', () => {
    expect(normaliseHex('#ABC')).toBe('#aabbcc');
    expect(normaliseHex('D6336C')).toBe('#d6336c');
    expect(normaliseHex('red')).toBeNull();
  });

  it('computes WCAG luminance and a known CIEDE2000 pair', () => {
    expect(relativeLuminance('#000000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 6);
    expect(deltaE2000('#d6336c', '#d6336c')).toBe(0);
    // Sharma's reference pair 1 (Lab 50/2.6772/-79.7751 vs 50/0/-82.7485) is 2.0425; sRGB inputs land near it.
    expect(deltaE2000('#000000', '#ffffff')).toBeGreaterThan(99);
  });
});

describe('the default palette and the reserved colours', () => {
  it('has 12 colours with a minimum pairwise ΔE of at least 11.5', () => {
    expect(DEFAULT_ROOM_PALETTE).toHaveLength(12);
    let min = Infinity;
    for (const [i, a] of DEFAULT_ROOM_PALETTE.entries()) {
      for (const b of DEFAULT_ROOM_PALETTE.slice(i + 1)) min = Math.min(min, deltaE2000(a.hex, b.hex));
    }
    expect(min).toBeGreaterThanOrEqual(11.5);
  });

  it('keeps every default at least 12 from every reserved colour', () => {
    for (const { hex } of DEFAULT_ROOM_PALETTE) {
      for (const reserved of Object.values(RESERVED_COLOURS)) expect(deltaE2000(hex, reserved), hex).toBeGreaterThanOrEqual(12);
      expect(nearReserved(hex)).toEqual([]);
    }
  });

  it('warns when a colour sits near the HQ teal: jade does', () => {
    expect(nearReserved(JADE).map((hit) => hit.name)).toContain('headquarters');
  });

  it('every default already has a body luminance inside the clamp', () => {
    for (const { hex } of DEFAULT_ROOM_PALETTE) expect(clampBody(hex)).toEqual({ hex, adjusted: false });
  });
});

describe('clampBody', () => {
  it('lifts a too-dark colour and lowers a too-light one into [0.15, 0.50], keeping the hue', () => {
    const dark = clampBody('#101030');
    expect(dark.adjusted).toBe(true);
    expect(relativeLuminance(dark.hex)).toBeGreaterThanOrEqual(BODY_LUMINANCE.min);
    expect(relativeLuminance(dark.hex)).toBeLessThan(0.2);
    const light = clampBody('#f0f0ff');
    expect(light.adjusted).toBe(true);
    expect(relativeLuminance(light.hex)).toBeLessThanOrEqual(BODY_LUMINANCE.max);
    expect(relativeLuminance(light.hex)).toBeGreaterThan(0.45);
  });

  it('the default accent is the base mixed 45 % towards white', () => {
    expect(defaultAccent('#000000')).toBe('#737373');
    expect(defaultAccent('#d6336c')).toBe('#e88fae');
  });
});
