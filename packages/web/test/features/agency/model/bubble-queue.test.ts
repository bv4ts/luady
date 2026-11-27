import { describe, expect, it } from 'vitest';
import {
  BUBBLES_OPEN_MAX, BUBBLE_MAX_MS, BUBBLE_MIN_MS, EMPTY_BUBBLES, arrive, bubbleMs, fold, hold, keepOnly, nextFold, reopen, tick,
  type SaidArrival,
} from '../../../../src/features/agency/model/bubble-queue.js';

const said = (sessionId: string, seq: number, text = 'Tests pass.'): SaidArrival => ({ sessionId, seq, text });
const openIds = (queue: { open: readonly { sessionId: string }[] }): string[] => queue.open.map((bubble) => bubble.sessionId);

describe('bubbleMs', () => {
  it('gives short words 6 seconds, long words up to 20, in between by length', () => {
    expect(bubbleMs('ok')).toBe(BUBBLE_MIN_MS);
    expect(bubbleMs('x'.repeat(200))).toBe(10_000);
    expect(bubbleMs('x'.repeat(1200))).toBe(BUBBLE_MAX_MS);
    expect(bubbleMs(`   ${'x'.repeat(200)}   `)).toBe(10_000);
  });
});

describe('the bubble queue', () => {
  it('opens a bubble when new words arrive, with its time by length', () => {
    const queue = arrive(EMPTY_BUBBLES, [said('a', 1)], 1_000);
    expect(queue.open).toEqual([{ sessionId: 'a', seq: 1, until: 1_000 + BUBBLE_MIN_MS }]);
    expect(queue.seen).toBe(1);
  });

  it('takes each arrival once: feeding the same words again changes nothing', () => {
    const once = arrive(EMPTY_BUBBLES, [said('a', 1)], 1_000);
    expect(arrive(once, [said('a', 1)], 5_000)).toEqual(once);
  });

  it('words that came with the page load leave only a speech mark', () => {
    const queue = arrive(EMPTY_BUBBLES, [said('a', 0), said('b', 0)], 0);
    expect(queue.open).toEqual([]);
    expect(queue.folded).toEqual(['a', 'b']);
  });

  it(`keeps at most ${BUBBLES_OPEN_MAX} open; the oldest folds first`, () => {
    let queue = EMPTY_BUBBLES;
    for (const [index, id] of ['a', 'b', 'c', 'd', 'e', 'f'].entries()) queue = arrive(queue, [said(id, index + 1)], index * 100);
    expect(openIds(queue)).toEqual(['c', 'd', 'e', 'f']);
    expect(queue.folded).toEqual(['a', 'b']);
  });

  it('several arrivals in one go open in arrival order', () => {
    const queue = arrive(EMPTY_BUBBLES, [said('b', 3), said('a', 2), said('c', 4)], 0);
    expect(openIds(queue)).toEqual(['a', 'b', 'c']);
  });

  it('new words from a session with an open bubble restart it at the end of the line', () => {
    let queue = arrive(EMPTY_BUBBLES, [said('a', 1), said('b', 2)], 0);
    queue = arrive(queue, [said('a', 3, 'x'.repeat(400))], 2_000);
    expect(openIds(queue)).toEqual(['b', 'a']);
    expect(queue.open[1]).toEqual({ sessionId: 'a', seq: 3, until: 2_000 + BUBBLE_MAX_MS });
  });

  it('folds a bubble when its time is up, and not before', () => {
    const queue = arrive(EMPTY_BUBBLES, [said('a', 1)], 0);
    expect(tick(queue, BUBBLE_MIN_MS - 1)).toBe(queue);
    const folded = tick(queue, BUBBLE_MIN_MS);
    expect(folded.open).toEqual([]);
    expect(folded.folded).toEqual(['a']);
  });

  it('a folded bubble reopens from its mark for its full time', () => {
    const folded = tick(arrive(EMPTY_BUBBLES, [said('a', 1)], 0), 10_000);
    const again = reopen(folded, said('a', 1), 20_000);
    expect(again.open).toEqual([{ sessionId: 'a', seq: 1, until: 20_000 + BUBBLE_MIN_MS }]);
    expect(again.folded).toEqual([]);
    expect(reopen(again, said('a', 1), 21_000)).toBe(again);
  });

  it('reopening counts towards the limit: the oldest open bubble folds', () => {
    let queue = arrive(EMPTY_BUBBLES, [said('z', 0)], 0);
    queue = arrive(queue, [said('a', 1), said('b', 2), said('c', 3), said('d', 4)], 0);
    queue = reopen(queue, said('z', 0), 100);
    expect(openIds(queue)).toEqual(['b', 'c', 'd', 'z']);
    expect(queue.folded).toEqual(['a']);
  });

  it('the owner can fold a bubble at once', () => {
    const queue = fold(arrive(EMPTY_BUBBLES, [said('a', 1)], 0), 'a');
    expect(queue.open).toEqual([]);
    expect(queue.folded).toEqual(['a']);
    expect(fold(queue, 'a')).toBe(queue);
  });

  it('forgets sessions that left the map', () => {
    const queue = arrive(EMPTY_BUBBLES, [said('a', 1), said('b', 0)], 0);
    const kept = keepOnly(queue, new Set(['a']));
    expect(openIds(kept)).toEqual(['a']);
    expect(kept.folded).toEqual([]);
    expect(keepOnly(kept, new Set(['a']))).toBe(kept);
  });

  it('says when the next bubble folds', () => {
    expect(nextFold(EMPTY_BUBBLES)).toBeNull();
    const queue = arrive(EMPTY_BUBBLES, [said('a', 1, 'x'.repeat(400)), said('b', 2)], 0);
    expect(nextFold(queue)).toBe(BUBBLE_MIN_MS);
  });

  it('holds a bubble open while the owner reads it, never shortening it', () => {
    const queue = arrive(EMPTY_BUBBLES, [said('a', 1)], 0);
    const held = hold(queue, 'a', 60_000);
    expect(held.open[0]?.until).toBe(60_000);
    expect(hold(held, 'a', 1_000)).toBe(held);
    expect(hold(held, 'zzz', 90_000)).toBe(held);
  });
});
