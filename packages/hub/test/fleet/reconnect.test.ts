import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LinkStatus } from '../../src/fleet/executor.js';
import { backoffDelay, createReconnector } from '../../src/fleet/reconnect.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reconnect policy', () => {
  it('backs off from 1 s to 60 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((failures) => backoffDelay(failures))).toEqual([
      1000, 1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000,
    ]);
  });

  it('goes offline after three failed attempts and recovers with backoff', async () => {
    let attempts = 0;
    const connect = vi.fn(async () => {
      attempts += 1;
      if (attempts <= 3) throw new Error(`refused ${attempts}`);
    });
    const failures: number[] = [];
    const reconnector = createReconnector({ connect, onFailure: (_err, count) => failures.push(count) });
    const seen: LinkStatus[] = [];
    reconnector.onStatus((status) => seen.push(status));
    reconnector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(reconnector.status()).toBe('connecting');
    await vi.advanceTimersByTimeAsync(2000);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(reconnector.status()).toBe('offline');
    await vi.advanceTimersByTimeAsync(3999);
    expect(connect).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(reconnector.status()).toBe('online');
    expect(seen).toEqual(['offline', 'online']);
    expect(failures).toEqual([1, 2, 3]);
    reconnector.stop();
  });

  it('reconnects after an established connection drops', async () => {
    const connect = vi.fn(async () => undefined);
    const reconnector = createReconnector({ connect });
    const seen: LinkStatus[] = [];
    reconnector.onStatus((status) => seen.push(status));
    reconnector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconnector.status()).toBe('online');
    reconnector.connectionLost();
    expect(reconnector.status()).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(seen).toEqual(['online', 'connecting', 'online']);
    reconnector.stop();
  });

  it('stop() cancels pending retries', async () => {
    const connect = vi.fn(async () => {
      throw new Error('refused');
    });
    const reconnector = createReconnector({ connect });
    reconnector.start();
    await vi.advanceTimersByTimeAsync(0);
    reconnector.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
