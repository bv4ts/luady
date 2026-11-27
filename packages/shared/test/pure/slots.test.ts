import { describe, expect, it } from 'vitest';
import { SLOT_MEMO_MAX, computeSlot, gridFor, slotAt, slotCountOf, slotsGenerated } from '../../src/pure/slots.js';

describe('slot order', () => {
  it('slots 0-3 are the first ring: nw, ne, sw, se', () => {
    expect([0, 1, 2, 3].map(slotAt)).toEqual([
      { index: 0, side: 'west', col: 1, row: 0, half: 'north' },
      { index: 1, side: 'east', col: 1, row: 0, half: 'north' },
      { index: 2, side: 'west', col: 1, row: 0, half: 'south' },
      { index: 3, side: 'east', col: 1, row: 0, half: 'south' },
    ]);
  });

  it('then grows by a column on both sides (all rows), then by a row (all columns)', () => {
    expect([4, 5, 6, 7].map((i) => [slotAt(i).side, slotAt(i).col, slotAt(i).row, slotAt(i).half])).toEqual([
      ['west', 2, 0, 'north'], ['east', 2, 0, 'north'], ['west', 2, 0, 'south'], ['east', 2, 0, 'south'],
    ]);
    expect(slotAt(8)).toEqual({ index: 8, side: 'west', col: 1, row: 1, half: 'north' });
    expect(slotAt(15)).toEqual({ index: 15, side: 'east', col: 2, row: 1, half: 'south' });
    expect(slotAt(16)).toEqual({ index: 16, side: 'west', col: 3, row: 0, half: 'north' });
  });

  it('never repeats a slot: every (side, col, row, half) appears once in the first 300', () => {
    const keys = Array.from({ length: 300 }, (_, i) => {
      const s = slotAt(i);
      return `${s.side}:${s.col}:${s.row}:${s.half}`;
    });
    expect(new Set(keys).size).toBe(300);
  });

  it('memoises: a second read generates nothing, and reads are O(1) amortised (counted, not timed)', () => {
    slotAt(299);
    const before = slotsGenerated();
    for (let i = 0; i < 300; i += 1) slotAt(i);
    expect(slotsGenerated()).toBe(before);
    // Growing to 400 generates only the whole blocks it needs, never more than one block past it.
    slotAt(400);
    expect(slotsGenerated() - before).toBeLessThanOrEqual(400 - before + 4 * 11);
    expect(slotsGenerated()).toBeGreaterThan(400);
  });

  it('refuses a negative or fractional index', () => {
    expect(() => slotAt(-1)).toThrow(RangeError);
    expect(() => slotAt(1.5)).toThrow(RangeError);
  });
});

describe('gridFor', () => {
  it('has the capacities 4, 8, 16, 24, 36, 48, 64, 80, 100, 120, 144', () => {
    const caps: number[] = [];
    for (let n = 1; caps.length < 11; n += 1) {
      const cap = gridFor(n).capacity;
      if (caps.at(-1) !== cap) caps.push(cap);
    }
    expect(caps).toEqual([4, 8, 16, 24, 36, 48, 64, 80, 100, 120, 144]);
  });

  it('gridFor(0) is K=1, R=1, capacity 4; 100 gives K=5, R=5; 300 gives K=9, R=9', () => {
    expect(gridFor(0)).toEqual({ K: 1, R: 1, capacity: 4 });
    expect(gridFor(4)).toEqual({ K: 1, R: 1, capacity: 4 });
    expect(gridFor(5)).toEqual({ K: 2, R: 1, capacity: 8 });
    expect(gridFor(100)).toEqual({ K: 5, R: 5, capacity: 100 });
    expect(gridFor(300)).toEqual({ K: 9, R: 9, capacity: 324 });
  });

  it('agrees with the slot order: the grid for n slots holds slot n-1', () => {
    for (const n of [1, 4, 5, 9, 17, 25, 37, 99, 101, 250]) {
      const { K, R } = gridFor(n);
      const last = slotAt(n - 1);
      expect(last.col).toBeLessThanOrEqual(K);
      expect(last.row).toBeLessThan(R);
    }
  });
});

describe('slotCountOf', () => {
  it('is 0 with no rooms, else the highest position plus one (sparse positions count)', () => {
    expect(slotCountOf([])).toBe(0);
    expect(slotCountOf([1, 2, 3, 4])).toBe(5);
    expect(gridFor(slotCountOf([1, 2, 3, 4]))).toEqual({ K: 2, R: 1, capacity: 8 });
  });

  it('takes a very long list (no spread into Math.max, which throws past the argument limit)', () => {
    const many = Array.from({ length: 300_000 }, (_, i) => 299_999 - i);
    expect(slotCountOf(many)).toBe(300_000);
  });
});

describe('slot maths for a stray huge position (no unbounded memo)', () => {
  it('computes a huge slot directly without growing the memo', () => {
    slotAt(10);
    const before = slotsGenerated();
    const far = slotAt(1_000_000_000_000);
    expect(slotsGenerated()).toBe(before);
    const { K, R } = gridFor(1_000_000_000_001);
    expect(far.index).toBe(1_000_000_000_000);
    expect(far.col).toBeLessThanOrEqual(K);
    expect(far.row).toBeLessThan(R);
  });

  it('the direct formula equals the memoised order, slot for slot', () => {
    for (let i = 0; i < 3000; i += 1) expect(computeSlot(i), `slot ${i}`).toEqual(slotAt(i));
  });

  it('beyond the memo bound the slots keep the same order: distinct, inside their grid', () => {
    const keys = new Set<string>();
    for (let i = SLOT_MEMO_MAX - 50; i < SLOT_MEMO_MAX + 50; i += 1) {
      const s = slotAt(i);
      const { K, R } = gridFor(i + 1);
      expect(s.col).toBeLessThanOrEqual(K);
      expect(s.row).toBeLessThan(R);
      keys.add(`${s.side}:${s.col}:${s.row}:${s.half}`);
    }
    expect(keys.size).toBe(100);
  });

  it('refuses an index past the safe integers, and gridFor refuses a count that is not finite', () => {
    expect(() => slotAt(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
    expect(() => gridFor(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
