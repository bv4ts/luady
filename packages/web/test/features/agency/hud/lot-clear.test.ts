import { describe, expect, it } from 'vitest';
import { LOT_CLEAR_GAP_PX, clearOfAreas, pinSpot } from '../../../../src/features/agency/hud/map-pins.js';
import type { OverlayPoint } from '../../../../src/features/agency/stage-types.js';

/**
 * The top-right lot's "+ Add room" at 1440×900 (classic office without Harbor, whole-office view): its top inside
 * edge sits right under the top bar, where the notice toasts stack (right: 12px, width 22rem, top: bar + 8px).
 */
const LOT: OverlayPoint = { kind: 'room', id: 'lot-1', x: 993, y: 90, footY: 90, maxWidth: 410, visible: true, scale: 1.07 };
const PLAQUE = { w: 112, h: 24 };
const toast = (index: number) => ({ x: 1440 - 12 - 352, y: 64 + index * 92, w: 352, h: 84 });

describe('a lot plaque never sits under the notice toasts', () => {
  it('without toasts it stays on its lot\'s top inside edge', () => {
    const spot = pinSpot(LOT, 'lot');
    expect(spot).not.toBeNull();
    expect(clearOfAreas(spot!, PLAQUE, [])).toBe(spot);
  });

  it.each([1, 2, 3])('with %i toasts at 1440×900 it moves just below the last one it would meet', (count) => {
    const toasts = Array.from({ length: count }, (_, i) => toast(i));
    const spot = clearOfAreas(pinSpot(LOT, 'lot')!, PLAQUE, toasts);
    const last = toasts.at(-1)!;
    expect(spot.y).toBe(last.y + last.h + LOT_CLEAR_GAP_PX);
    for (const t of toasts) {
      const overlaps = spot.x - PLAQUE.w / 2 < t.x + t.w && t.x < spot.x + PLAQUE.w / 2 && spot.y < t.y + t.h && t.y < spot.y + PLAQUE.h;
      expect(overlaps).toBe(false);
    }
  });

  it('a toast elsewhere (another column) leaves it where it is', () => {
    const spot = pinSpot(LOT, 'lot')!;
    expect(clearOfAreas(spot, PLAQUE, [{ x: 0, y: 64, w: 300, h: 84 }])).toBe(spot);
  });
});
