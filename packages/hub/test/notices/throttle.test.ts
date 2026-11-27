import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThrottle, CHAT_FLUSH_GAP_MS } from '../../src/notices/throttle.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

function recorder() {
  const started: Array<{ name: string; at: number }> = [];
  const task = (name: string, fail = false) => async (): Promise<void> => {
    started.push({ name, at: Date.now() });
    if (fail) throw new Error(`${name} failed`);
  };
  return { started, task };
}

describe('send throttle', () => {
  it('starts tasks in order, at least 3 seconds apart', async () => {
    const throttle = createThrottle(CHAT_FLUSH_GAP_MS);
    const r = recorder();
    throttle.run(r.task('a'));
    throttle.run(r.task('b'));
    throttle.run(r.task('c'));
    expect(throttle.size()).toBe(2);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(r.started.map((s) => s.name)).toEqual(['a']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.started).toEqual([{ name: 'a', at: 0 }, { name: 'b', at: 3_000 }, { name: 'c', at: 6_000 }]);
    expect(throttle.size()).toBe(0);
    expect(CHAT_FLUSH_GAP_MS).toBe(3_000);
  });

  it('a task added once the queue is idle starts at once', async () => {
    const throttle = createThrottle(CHAT_FLUSH_GAP_MS);
    const r = recorder();
    throttle.run(r.task('a'));
    await vi.advanceTimersByTimeAsync(10_000);
    throttle.run(r.task('late'));
    expect(r.started).toEqual([{ name: 'a', at: 0 }, { name: 'late', at: 10_000 }]);
  });

  it('a rejecting task does not stop the next one', async () => {
    const throttle = createThrottle(CHAT_FLUSH_GAP_MS);
    const r = recorder();
    throttle.run(r.task('bad', true));
    throttle.run(r.task('good'));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(r.started.map((s) => s.name)).toEqual(['bad', 'good']);
  });

  it('stop() drops what has not started and the throttle can be used again', async () => {
    const throttle = createThrottle(CHAT_FLUSH_GAP_MS);
    const r = recorder();
    throttle.run(r.task('a'));
    throttle.run(r.task('b'));
    throttle.run(r.task('c'));
    throttle.stop();
    expect(throttle.size()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.started.map((s) => s.name)).toEqual(['a']);
    throttle.run(r.task('d'));
    expect(r.started.map((s) => s.name)).toEqual(['a', 'd']);
  });
});
