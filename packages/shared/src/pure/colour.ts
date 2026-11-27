/**
 * Room colours: parsing, WCAG luminance, CIEDE2000 distance, the body clamp, the reserved colours,
 * the default palette and the default accent. Pure: no imports. Every colour is a lower-case `#rrggbb` string.
 */

const HEX_RE = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

/** The body colour's luminance is kept in this range, so the art's dark shade and light shade stay readable. */
export const BODY_LUMINANCE = Object.freeze({ min: 0.15, max: 0.5 });
/** Warn below this ΔE2000 from a reserved colour, and below ROOM_WARN_DELTA_E from another room. */
export const RESERVED_WARN_DELTA_E = 12;
export const ROOM_WARN_DELTA_E = 10;
/** How far the default accent moves towards white. */
export const DEFAULT_ACCENT_LIGHTEN = 0.45;

/** Colours a room should not look like: the HQ teal, the paused grey and the HUD's alert, warn and ok. */
export const RESERVED_COLOURS = Object.freeze({
  headquarters: '#3cc3b0', mute: '#6c7689', alert: '#ff7a68', warn: '#ffc066', ok: '#7ddc8f',
} as const);

/** The 12 named defaults, in the order a new room takes them. */
export const DEFAULT_ROOM_PALETTE = Object.freeze([
  { name: 'Rose', hex: '#d6336c' }, { name: 'Amber', hex: '#f76707' }, { name: 'Violet', hex: '#7c5cff' },
  { name: 'Azure', hex: '#3d7bff' }, { name: 'Cyan', hex: '#19b6d2' }, { name: 'Ocean', hex: '#1f8fbf' },
  { name: 'Lilac', hex: '#a78bfa' }, { name: 'Orchid', hex: '#c04fd6' }, { name: 'Moss', hex: '#6f9a3a' },
  { name: 'Cocoa', hex: '#b07a4a' }, { name: 'Brick', hex: '#c4512b' }, { name: 'Pine', hex: '#2b8a3e' },
] as const);

/** Lower-case `#rrggbb` from `#rgb`, `#rrggbb` or the same without `#`; null when it is not a colour. */
export function normaliseHex(value: string): string | null {
  const match = HEX_RE.exec(value.trim());
  if (match === null) return null;
  const digits = match[1] ?? '';
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  return `#${full.toLowerCase()}`;
}

type Rgb = readonly [number, number, number];

function rgbOf(hex: string): Rgb {
  const norm = normaliseHex(hex);
  if (norm === null) throw new RangeError(`expected a #rrggbb colour, got ${JSON.stringify(hex)}`);
  const at = (i: number): number => Number.parseInt(norm.slice(i, i + 2), 16);
  return [at(1), at(3), at(5)];
}

const hexOf = (rgb: readonly number[]): string =>
  `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

const linear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = rgbOf(hex);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** CIE L*a*b* under D65. */
function labOf(hex: string): readonly [number, number, number] {
  const [r, g, b] = rgbOf(hex).map(linear) as unknown as Rgb;
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const DEG = Math.PI / 180;

/** CIEDE2000 colour difference between two colours (kL = kC = kH = 1). */
export function deltaE2000(a: string, b: string): number {
  const [L1, a1, b1] = labOf(a);
  const [L2, a2, b2] = labOf(b);
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (bb: number, ap: number): number => {
    if (bb === 0 && ap === 0) return 0;
    const h = Math.atan2(bb, ap) / DEG;
    return h < 0 ? h + 360 : h;
  };
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * DEG);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else hbarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hbarp - 30) * DEG) + 0.24 * Math.cos(2 * hbarp * DEG)
    + 0.32 * Math.cos((3 * hbarp + 6) * DEG) - 0.2 * Math.cos((4 * hbarp - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * DEG) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

/** RGB to HSL (h in degrees, s and l in 0..1), and back. */
function hslOf(hex: string): readonly [number, number, number] {
  const [r, g, b] = rgbOf(hex).map((v) => v / 255) as unknown as Rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hexFromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return hexOf([(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255]);
}

/**
 * Brings a body colour's luminance into [0.15, 0.50] by moving its HSL lightness, keeping hue and saturation.
 * `adjusted` says whether the colour changed (beyond normalising).
 */
export function clampBody(hex: string): { readonly hex: string; readonly adjusted: boolean } {
  const norm = normaliseHex(hex);
  if (norm === null) throw new RangeError(`expected a #rrggbb colour, got ${JSON.stringify(hex)}`);
  const lum = relativeLuminance(norm);
  if (lum >= BODY_LUMINANCE.min && lum <= BODY_LUMINANCE.max) return { hex: norm, adjusted: false };
  const [h, s, l] = hslOf(norm);
  const tooDark = lum < BODY_LUMINANCE.min;
  // Luminance rises with lightness: search the lightness whose colour sits just inside the range.
  let lo = tooDark ? l : 0;
  let hi = tooDark ? 1 : l;
  let best = tooDark ? hexFromHsl(h, s, hi) : hexFromHsl(h, s, lo);
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    const candidate = hexFromHsl(h, s, mid);
    const value = relativeLuminance(candidate);
    if (tooDark) {
      if (value >= BODY_LUMINANCE.min) {
        best = candidate;
        hi = mid;
      } else {
        lo = mid;
      }
    } else if (value <= BODY_LUMINANCE.max) {
      best = candidate;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return { hex: best, adjusted: best !== norm };
}

/** Mixes a colour towards white by `amount` (0..1). */
export function lightenHex(hex: string, amount: number): string {
  const k = Math.max(0, Math.min(1, Number.isNaN(amount) ? 0 : amount));
  return hexOf(rgbOf(hex).map((v) => v + (255 - v) * k));
}

/** The default accent of a room colour. */
export function defaultAccent(base: string): string {
  return lightenHex(base, DEFAULT_ACCENT_LIGHTEN);
}

/** Reserved colours closer than RESERVED_WARN_DELTA_E to `hex`, nearest first. */
export function nearReserved(hex: string): Array<{ readonly name: string; readonly deltaE: number }> {
  return Object.entries(RESERVED_COLOURS)
    .map(([name, reserved]) => ({ name, deltaE: deltaE2000(hex, reserved) }))
    .filter((hit) => hit.deltaE < RESERVED_WARN_DELTA_E)
    .sort((a, b) => a.deltaE - b.deltaE);
}
