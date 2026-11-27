import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '@luady/shared';
import { createGatherer } from '../../src/luady/gather.js';

const clock = { now: () => new Date() };

function setup() {
  const delivered: Array<{ texts: readonly string[]; channel: Channel }> = [];
  const gatherer = createGatherer(clock, { quietMs: 3_000, maxMs: 12_000 }, (texts, channel) => delivered.push({ texts, channel }));
  return { gatherer, delivered };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: new Date('2026-10-18T17:00:00.000Z') });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createGatherer', () => {
  it('hands a burst of messages (text, then photos) to Luady as one prompt once the owner pauses', async () => {
    const t = setup();
    t.gatherer.push('Go to meadow-vat and fix those :', 'test-channel');
    await vi.advanceTimersByTimeAsync(2_000);
    t.gatherer.push('[Attached image "a.jpg" (image/jpeg, 3 KB): /inbox/a.jpg]', 'test-channel');
    t.gatherer.push('Change it to Supplier Bills Summary', 'test-channel');
    await vi.advanceTimersByTimeAsync(2_999);
    expect(t.delivered).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.delivered).toEqual([{
      texts: ['Go to meadow-vat and fix those :', '[Attached image "a.jpg" (image/jpeg, 3 KB): /inbox/a.jpg]', 'Change it to Supplier Bills Summary'],
      channel: 'test-channel',
    }]);
  });

  it('never holds the first message longer than maxMs, even while messages keep coming', async () => {
    const t = setup();
    for (let i = 0; i < 6; i += 1) {
      t.gatherer.push(`m${i}`, 'test-channel');
      await vi.advanceTimersByTimeAsync(2_500);
    }
    expect(t.delivered.map((d) => d.texts)).toEqual([['m0', 'm1', 'm2', 'm3', 'm4']]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.delivered.map((d) => d.texts)).toEqual([['m0', 'm1', 'm2', 'm3', 'm4'], ['m5']]);
  });

  it('releases at once when the channel changes, and on drain', () => {
    const t = setup();
    t.gatherer.push('from the phone', 'test-channel');
    t.gatherer.push('from the website', 'web');
    expect(t.delivered).toEqual([{ texts: ['from the phone'], channel: 'test-channel' }]);
    t.gatherer.drain();
    expect(t.delivered.at(-1)).toEqual({ texts: ['from the website'], channel: 'web' });
  });
});
