import { describe, expect, it } from 'vitest';
import { FUEL_TINT, FUEL_W, fuelBar } from '../../../../src/features/agency/scene/fuel.js';

describe('fuelBar', () => {
  it('is green below 60, amber from 60, red from 85', () => {
    expect(fuelBar(10)?.tint).toBe(FUEL_TINT.green);
    expect(fuelBar(59.9)?.tint).toBe(FUEL_TINT.green);
    expect(fuelBar(60)?.tint).toBe(FUEL_TINT.amber);
    expect(fuelBar(84)?.tint).toBe(FUEL_TINT.amber);
    expect(fuelBar(85)?.tint).toBe(FUEL_TINT.red);
    expect(fuelBar(100)?.tint).toBe(FUEL_TINT.red);
  });

  it('fills the screen width in proportion, at least one pixel', () => {
    expect(fuelBar(100)?.width).toBe(FUEL_W);
    expect(fuelBar(50)?.width).toBe(7);
    expect(fuelBar(0)?.width).toBe(1);
    expect(fuelBar(250)).toEqual({ width: FUEL_W, tint: FUEL_TINT.red });
  });

  it('shows nothing without a reading', () => {
    expect(fuelBar(null)).toBeNull();
    expect(fuelBar(Number.NaN)).toBeNull();
  });
});
