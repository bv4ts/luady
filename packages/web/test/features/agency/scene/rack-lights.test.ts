import type { RackView } from '@luady/office';
import { describe, expect, it } from 'vitest';
import { RACK_ROWS, blinkPeriod, hexToTint, rackLights } from '../../../../src/features/agency/scene/rack-lights.js';

const rack = (over: Partial<RackView> = {}): RackView => ({ status: 'online', load: 0.5, memory: 'ok', disk: 'ok', ...over });
const TEAM = 0xd6336c;
const activity = (r: RackView | null, now: number): number[] => rackLights(r, TEAM, now, 7).map((row) => row.activity);
const lit = (r: RackView, now: number): Set<number> => new Set(activity(r, now).filter((c) => c !== 0x1f3b2d));

describe('rackLights', () => {
  it('is dark when the server is not online or has no numbers yet', () => {
    for (const r of [null, rack({ status: 'offline' }), rack({ status: 'connecting' })]) {
      const rows = rackLights(r, TEAM, 12_345, 3);
      expect(rows).toHaveLength(RACK_ROWS);
      rows.forEach((row) => expect(row).toEqual({ activity: 0x1f3b2d, team: 0x27324a }));
    }
  });

  it('shows green activity, amber for tight memory and red for a low disk', () => {
    expect(lit(rack(), 1000)).toEqual(new Set([0x54d38a]));
    expect(lit(rack({ memory: 'tight' }), 1000)).toEqual(new Set([0xffb648]));
    expect(lit(rack({ memory: 'tight', disk: 'low' }), 1000)).toEqual(new Set([0xe23a2e]));
  });

  it('blinks faster under load', () => {
    expect(blinkPeriod(0)).toBe(900);
    expect(blinkPeriod(1)).toBe(160);
    expect(blinkPeriod(0.5)).toBeLessThan(blinkPeriod(0.1));
    expect(blinkPeriod(Number.NaN)).toBe(900);
    const changes = (load: number): number => {
      let count = 0;
      for (let t = 0; t < 10_000; t += 20) if (activity(rack({ load }), t).join() !== activity(rack({ load }), t + 20).join()) count += 1;
      return count;
    };
    expect(changes(1)).toBeGreaterThan(changes(0) * 3);
  });

  it('stands still at time zero (reduced motion)', () => {
    expect(rackLights(rack(), TEAM, 0, 4)).toEqual(rackLights(rack(), TEAM, 0, 4));
  });
});

describe('hexToTint', () => {
  it('reads #rrggbb', () => {
    expect(hexToTint('#3cc3b0')).toBe(0x3cc3b0);
    expect(hexToTint('nonsense')).toBe(0xffffff);
  });
});
