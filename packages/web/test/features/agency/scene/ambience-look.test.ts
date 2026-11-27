import { describe, expect, it } from 'vitest';
import { DUSK_LOOK, INDOOR_DAY_LIFT, LAMP_GLASS, SKY_GLASS, ambienceLook, sameLook } from '../../../../src/features/agency/scene/ambience-look.js';

const ON = { enabled: true, quiet: false, reduced: false };
const level = (tint: number): number => ((tint >> 16) & 0xff) + ((tint >> 8) & 0xff) + (tint & 0xff);

describe('ambienceLook', () => {
  it('keeps the drawn art (the dusk look) at the middle of the ramp and when switched off', () => {
    expect(ambienceLook({ phase: 'dusk', light: 0.5 }, ON)).toEqual(DUSK_LOOK);
    expect(ambienceLook({ phase: 'day', light: 1 }, { ...ON, enabled: false })).toBe(DUSK_LOOK);
    expect(ambienceLook({ phase: 'night', light: 0 }, { enabled: false, quiet: true, reduced: true })).toBe(DUSK_LOOK);
  });

  it('brightens the garden and the floors and lets the sun in by day, the glass showing the sky', () => {
    const day = ambienceLook({ phase: 'day', light: 1 }, ON);
    expect(day).toMatchObject({ gardenTint: 0xffffff, buildingTint: 0xffffff, gardenDay: 1, sun: 1, glassTint: SKY_GLASS, lamps: 0, spill: 0 });
    expect(day.glass).toBeGreaterThan(0);
  });

  it('lifts the floors only a little by day, so floors, furniture and characters keep their contrast indoors', () => {
    const day = ambienceLook({ phase: 'day', light: 1 }, ON);
    expect(day.indoorDay).toBeGreaterThan(0);
    expect(day.indoorDay).toBeLessThanOrEqual(INDOOR_DAY_LIFT);
    expect(INDOOR_DAY_LIFT).toBeLessThanOrEqual(0.4);
    expect(day.sun).toBe(1);
  });

  it('darkens the garden more than the building at night, and lights the lamps and the panes', () => {
    const night = ambienceLook({ phase: 'night', light: 0 }, ON);
    expect(level(night.gardenTint)).toBeLessThan(level(night.buildingTint));
    expect(level(night.buildingTint)).toBeLessThan(3 * 255);
    expect(night).toMatchObject({ gardenDay: 0, indoorDay: 0, sun: 0, glassTint: LAMP_GLASS });
    expect(night.lamps).toBeGreaterThan(0.4);
    expect(night.spill).toBeGreaterThan(0.4);
    expect(night.glass).toBeGreaterThan(0.8);
  });

  it('blends through dawn and dusk', () => {
    const a = ambienceLook({ phase: 'dawn', light: 0.6 }, ON);
    const b = ambienceLook({ phase: 'dawn', light: 0.9 }, ON);
    expect(a.gardenDay).toBeGreaterThan(0);
    expect(b.gardenDay).toBeGreaterThan(a.gardenDay);
    const c = ambienceLook({ phase: 'dusk', light: 0.3 }, ON);
    expect(c.lamps).toBeGreaterThan(0);
    expect(c.lamps).toBeLessThan(ambienceLook({ phase: 'night', light: 0 }, ON).lamps);
  });

  it('moves in steps with reduced motion', () => {
    const looks = Array.from({ length: 101 }, (_, i) => ambienceLook({ phase: 'dawn', light: i / 100 }, { ...ON, reduced: true }));
    const distinct = looks.filter((l, i) => i === 0 || !sameLook(l, looks[i - 1]!));
    expect(distinct).toHaveLength(5);
  });

  it('lowers HQ lights in quiet hours', () => {
    expect(ambienceLook({ phase: 'night', light: 0 }, { ...ON, quiet: true }).quiet).toBeGreaterThan(0);
    expect(ambienceLook({ phase: 'night', light: 0 }, ON).quiet).toBe(0);
  });
});
