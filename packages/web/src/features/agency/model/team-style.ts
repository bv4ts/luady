import type { Palette } from '@luady/office';
import type { CSSProperties } from 'react';

const DARK_INK = '#0c101a';
const LIGHT_INK = '#ffffff';

const channel = (value: number): number => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff);
}

/** The text colour (dark or white) with the higher contrast on a room colour. */
export function inkOn(hex: string): string {
  const l = luminance(hex);
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (luminance(DARK_INK) + 0.05);
  return onDark >= onWhite ? DARK_INK : LIGHT_INK;
}

/**
 * A room's colours as CSS custom properties. React sets them through the CSSOM (element.style), which the
 * Content-Security-Policy allows; no style attribute string is ever written into markup.
 */
export function teamStyle(palette: Palette): CSSProperties {
  return { '--team': palette.base, '--team-accent': palette.accent, '--team-ink': inkOn(palette.base) } as CSSProperties;
}
