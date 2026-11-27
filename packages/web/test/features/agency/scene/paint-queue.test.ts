import { describe, expect, it } from 'vitest';
import { SLICE_MS, createPaintQueue, type PaintJob } from '../../../../src/features/agency/scene/paint-queue.js';

/** A fake clock that each job moves on by the work it declared. */
const setup = () => {
  let now = 0;
  const queue = createPaintQueue(() => now);
  const ran: string[] = [];
  const job = (key: string, priority: number, cost: number, actual = cost): PaintJob => ({
    key, priority, cost,
    run: () => {
      ran.push(key);
      now += actual;
    },
  });
  return { queue, ran, job, clock: () => now };
};

describe('createPaintQueue', () => {
  it('runs the jobs nearest the view centre first', () => {
    const { queue, ran, job } = setup();
    [['c', 30], ['a', 1], ['d', 40], ['b', 2]].forEach(([key, d]) => queue.enqueue(job(String(key), Number(d), 1)));
    while (queue.size() > 0) queue.slice();
    expect(ran).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never fills a slice past 8 ms of declared work', () => {
    const costs = [5, 5, 2, 7, 1, 1, 1, 8, 3, 4, 6, 2, 2, 2, 2, 5];
    const slices: number[] = [];
    let declared = 0;
    const tracking = createPaintQueue(() => declared);
    costs.forEach((cost, i) => tracking.enqueue({ key: `j${i}`, priority: i, cost, run: () => { declared += cost; } }));
    while (tracking.size() > 0) {
      const before = declared;
      tracking.slice();
      slices.push(declared - before);
    }
    expect(SLICE_MS).toBe(8);
    expect(slices.every((ms) => ms <= SLICE_MS)).toBe(true);
    expect(slices.reduce((a, b) => a + b, 0)).toBe(costs.reduce((a, b) => a + b, 0));
    expect(slices.length).toBeGreaterThan(costs.length / 4);
  });

  it('stops a slice early when the work takes longer than it declared', () => {
    const { queue, ran, job } = setup();
    queue.enqueue(job('slow', 0, 2, 7));
    queue.enqueue(job('next', 1, 2));
    expect(queue.slice()).toBe(1);
    expect(ran).toEqual(['slow']);
  });

  it('always runs one job per slice, so one larger than the slice still gets painted', () => {
    const { queue, ran, job } = setup();
    queue.enqueue(job('big', 0, 12));
    queue.enqueue(job('small', 1, 1));
    expect(queue.slice()).toBe(1);
    expect(ran).toEqual(['big']);
  });

  it('keeps one job per key: a second enqueue moves it, cancel and retain drop it', () => {
    const { queue, ran, job } = setup();
    queue.enqueue(job('x', 10, 1));
    queue.enqueue(job('y', 5, 1));
    queue.enqueue(job('x', 1, 1));
    expect(queue.size()).toBe(2);
    expect(queue.has('x')).toBe(true);
    queue.enqueue(job('z', 0, 1));
    queue.cancel('z');
    queue.enqueue(job('w', 0, 1));
    queue.retain((key) => key !== 'w');
    while (queue.size() > 0) queue.slice();
    expect(ran).toEqual(['x', 'y']);
  });

  it('keeps going after a job that throws, and reports it', () => {
    const { queue, ran, job } = setup();
    const errors: unknown[] = [];
    const guarded = createPaintQueue(() => 0, (error) => errors.push(error));
    guarded.enqueue({ key: 'bad', priority: 0, cost: 1, run: () => { throw new Error('boom'); } });
    guarded.enqueue(job('good', 1, 1));
    while (guarded.size() > 0) guarded.slice();
    expect(errors).toHaveLength(1);
    expect(ran).toEqual(['good']);
    expect(queue.size()).toBe(0);
  });
});
