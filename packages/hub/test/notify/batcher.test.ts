import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Clock, OutboundChannel } from '../../src/core/contracts.js';
import { createBatcher, type BatchItem } from '../../src/notify/batcher.js';
import { createFakeOutbound, silentLogger } from '../../test/helpers/fakes.js';

const clock: Clock = { now: () => new Date() };

function item(n: number): BatchItem {
  return { kind: 'finished', text: `full ${n}`, line: `line ${n}`, link: { kind: 'session', refId: `s${n}` } };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: new Date('2026-10-09T12:00:00.000Z'),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createBatcher', () => {
  it('sends the first three at once and combines the rest after 60 s', async () => {
    const outbound = createFakeOutbound();
    const batcher = createBatcher({ clock, log: silentLogger(), outbound });
    for (const n of [1, 2, 3, 4, 5]) await batcher.push(item(n));
    expect(outbound.sent.map((s) => s.text)).toEqual(['full 1', 'full 2', 'full 3']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outbound.sent).toHaveLength(4);
    expect(outbound.sent[3]?.text).toBe('📦 *2 updates*\nline 4\nline 5');
    expect(outbound.sent[3]?.link).toBeNull();
  });

  it('sends a single held item as itself, with its link', async () => {
    const outbound = createFakeOutbound();
    const batcher = createBatcher({ clock, log: silentLogger(), outbound });
    for (const n of [1, 2, 3, 4]) await batcher.push(item(n));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(outbound.sent[3]?.text).toBe('full 4');
    expect(outbound.sent[3]?.link).toEqual({ kind: 'session', refId: 's4' });
  });

  it('lets new items through once the window has passed', async () => {
    const outbound = createFakeOutbound();
    const batcher = createBatcher({ clock, log: silentLogger(), outbound });
    for (const n of [1, 2, 3]) await batcher.push(item(n));
    await vi.advanceTimersByTimeAsync(61_000);
    await batcher.push(item(4));
    expect(outbound.sent.map((s) => s.text)).toEqual(['full 1', 'full 2', 'full 3', 'full 4']);
  });

  it('logs send failures instead of throwing and drops held items on stop', async () => {
    const send = vi.fn(async () => {
      throw new Error('socket down');
    });
    const failing: OutboundChannel = { isUp: () => false, send };
    const batcher = createBatcher({ clock, log: silentLogger(), outbound: failing });
    await expect(batcher.push(item(1))).resolves.toBeUndefined();
    for (const n of [2, 3, 4]) await batcher.push(item(n));
    batcher.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
