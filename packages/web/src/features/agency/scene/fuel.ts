/** Context fuel: the bar along the bottom edge of a desk monitor. Pure. */

/** The bar spans the screen's width (14 px) and is two pixels tall. */
export const FUEL_W = 14;
export const FUEL_H = 2;
/** From these readings the bar turns amber, then red. */
export const FUEL_AMBER_PCT = 60;
export const FUEL_RED_PCT = 85;

export const FUEL_TINT = Object.freeze({ green: 0x54d38a, amber: 0xffb648, red: 0xe23a2e, track: 0x05070d });

export interface FuelBar { readonly width: number; readonly tint: number }

/** The bar for a context reading (0–100): its width in pixels (at least one) and colour; null with no reading. */
export function fuelBar(pct: number | null): FuelBar | null {
  if (pct === null || !Number.isFinite(pct)) return null;
  const clamped = Math.max(0, Math.min(100, pct));
  const tint = clamped >= FUEL_RED_PCT ? FUEL_TINT.red : clamped >= FUEL_AMBER_PCT ? FUEL_TINT.amber : FUEL_TINT.green;
  return Object.freeze({ width: Math.max(1, Math.round((clamped / 100) * FUEL_W)), tint });
}
