/**
 * The office's slot order and grid. A room's `position` is its slot index. Slots 0-3 are the
 * first ring around HQ (nw, ne, sw, se); after that the building grows alternately by one more column on both sides
 * (all rows) and one more row (all columns), so a slot never moves when the office grows. Pure: no imports.
 */

export type SlotSide = 'west' | 'east';
export type SlotHalf = 'north' | 'south';

export interface Slot {
  readonly index: number;
  readonly side: SlotSide;
  /** 1..K; 1 is next to HQ. */
  readonly col: number;
  /** 0..R-1. */
  readonly row: number;
  readonly half: SlotHalf;
}

/** K columns a side, R rows, and how many slots that holds (4, 8, 16, 24, 36, 48, 64, 80, 100, 120, 144, …). */
export interface Grid {
  readonly K: number;
  readonly R: number;
  readonly capacity: number;
}

/**
 * Slots below this index are memoised; a higher one is computed from the formula each time, so a stray huge position
 * costs O(log n) and allocates nothing (a sanity guard, not a limit on rooms).
 */
export const SLOT_MEMO_MAX = 10_000;

const SIDES: readonly SlotSide[] = ['west', 'east'];
const HALVES: readonly SlotHalf[] = ['north', 'south'];

/** The grid after `step` growth steps: even steps square it, odd steps add a column on both sides. */
function gridAtStep(step: number): Grid {
  const m = Math.floor(step / 2);
  return step % 2 === 0
    ? { K: m + 1, R: m + 1, capacity: 4 * (m + 1) * (m + 1) }
    : { K: m + 2, R: m + 1, capacity: 4 * (m + 1) * (m + 2) };
}

/**
 * The fewest growth steps whose grid holds `slotCount` slots: a binary search. The capacity after s steps is at least
 * (s + 1)², so s = ⌈√slotCount⌉ always holds them, which keeps the search and its numbers small.
 */
function stepFor(slotCount: number): number {
  let lo = 0;
  let hi = Math.max(1, Math.ceil(Math.sqrt(Math.max(0, slotCount))));
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (gridAtStep(mid).capacity >= slotCount) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The smallest grid holding `slotCount` slots (at least the first ring). Refuses a count that is not finite. */
export function gridFor(slotCount: number): Grid {
  if (!Number.isFinite(slotCount)) throw new RangeError(`slot count must be a finite number, got ${slotCount}`);
  return gridAtStep(stepFor(slotCount));
}

/** `slotCount` for a set of rooms: 0 with no rooms, else the highest position plus one (a loop: any length). */
export function slotCountOf(positions: readonly number[]): number {
  if (positions.length === 0) return 0;
  let highest = Number.NEGATIVE_INFINITY;
  for (const position of positions) if (position > highest) highest = position;
  return highest + 1;
}

/**
 * The slot at a position from the formula, without the memo: the growth block that holds it, then rows, halves,
 * columns and sides in that order (the order `slotAt` memoises).
 */
export function computeSlot(index: number): Slot {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError(`slot index must be a whole number >= 0, got ${index}`);
  const step = stepFor(index + 1);
  const start = step === 0 ? 0 : gridAtStep(step - 1).capacity;
  const m = Math.floor(step / 2);
  // Step 0: the first ring. Odd steps add column m + 2 on every row; even steps add row m across columns 1..m + 1.
  const block = step === 0
    ? { colFrom: 1, cols: 1, rowFrom: 0 }
    : step % 2 === 1 ? { colFrom: m + 2, cols: 1, rowFrom: 0 } : { colFrom: 1, cols: m + 1, rowFrom: m };
  const offset = index - start;
  const pair = Math.floor(offset / 2);
  const line = Math.floor(pair / block.cols);
  return {
    index,
    side: SIDES[offset % 2] ?? 'west',
    col: block.colFrom + (pair % block.cols),
    row: block.rowFrom + Math.floor(line / 2),
    half: HALVES[line % 2] ?? 'north',
  };
}

const memo: Slot[] = [];
let generated = 0;

/** Appends the slots of one growth block: rows, then halves, then columns, then sides. */
function emit(cols: readonly number[], rows: readonly number[]): void {
  for (const row of rows) {
    for (const half of HALVES) {
      for (const col of cols) {
        for (const side of SIDES) {
          memo.push({ index: memo.length, side, col, row, half });
          generated += 1;
        }
      }
    }
  }
}

const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

/** Grows the memo by whole blocks until it holds `index`. */
function extendTo(index: number): void {
  if (memo.length === 0) emit([1], [0]);
  let step = 0;
  let K = 1;
  let R = 1;
  // Replay the block sizes already emitted to know the next block.
  let size = 4;
  while (size < memo.length) {
    step += 1;
    if (step % 2 === 1) {
      K += 1;
      size += 4 * R;
    } else {
      R += 1;
      size += 4 * K;
    }
  }
  while (memo.length <= index) {
    step += 1;
    if (step % 2 === 1) {
      K += 1;
      emit([K], range(0, R));
    } else {
      emit(range(1, K + 1), [R]);
      R += 1;
    }
  }
}

/** The slot at a position. Memoised below SLOT_MEMO_MAX (O(1) amortised); computed in O(log n) above it. */
export function slotAt(index: number): Slot {
  if (!Number.isSafeInteger(index) || index < 0) throw new RangeError(`slot index must be a whole number >= 0, got ${index}`);
  if (index >= SLOT_MEMO_MAX) return computeSlot(index);
  if (index >= memo.length) extendTo(index);
  const slot = memo[index];
  if (slot === undefined) throw new RangeError(`slot ${index} was not generated`);
  return slot;
}

/** How many slots the memo has generated so far (the operation count the tests assert). */
export function slotsGenerated(): number {
  return generated;
}
