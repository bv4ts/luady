import { describe, expect, it } from 'vitest';
import { CHIP_ROOM_X, CHIP_ROOM_Y, chipSide } from '../../../../src/features/agency/give/DragChip.js';

describe('where the drag chip sits', () => {
  it('above and to the left of the pointer, so its tip and the target stay visible', () => {
    expect(chipSide(800, 500)).toEqual({ x: 'left', y: 'above' });
  });

  it('flips to the right or below only where the window has no room for it', () => {
    expect(chipSide(CHIP_ROOM_X - 1, 500)).toEqual({ x: 'right', y: 'above' });
    expect(chipSide(800, CHIP_ROOM_Y - 1)).toEqual({ x: 'left', y: 'below' });
    expect(chipSide(10, 10)).toEqual({ x: 'right', y: 'below' });
  });
});
