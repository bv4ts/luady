/** Colour helpers. Every colour is a lower-case '#rrggbb' string. */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const WHITE = '#ffffff';
/** The night tone used for shading. */
const NIGHT = '#080b14';

/** Reads '#rrggbb' into [r, g, b]. Throws a RangeError for any other format. */
export function hexToRgb(hex: string): readonly [number, number, number] {
  if (!HEX_RE.test(hex)) throw new RangeError(`expected a #rrggbb colour, got ${JSON.stringify(hex)}`);
  const channel = (at: number): number => Number.parseInt(hex.slice(at, at + 2), 16);
  return Object.freeze([channel(1), channel(3), channel(5)] as const);
}

const toHex = (channels: readonly number[]): string =>
  '#' + channels.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

const clamp01 = (t: number): number => (Number.isNaN(t) ? 0 : Math.max(0, Math.min(1, t)));

/** Blends a towards b by t (clamped to 0..1). */
export function mix(a: string, b: string, t: number): string {
  const from = hexToRgb(a);
  const to = hexToRgb(b);
  const k = clamp01(t);
  return toHex(from.map((v, i) => v + ((to[i] ?? v) - v) * k));
}

/** Blends towards white. */
export function lighten(c: string, t: number): string {
  return mix(c, WHITE, t);
}

/** Blends towards the night tone. */
export function darken(c: string, t: number): string {
  return mix(c, NIGHT, t);
}
