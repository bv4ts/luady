import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBus } from '../../src/core/bus.js';
import { openMemoryDb } from '../../src/db/open.js';
import type { LinkStatus } from '../../src/fleet/executor.js';
import { createFleetWith } from '../../src/fleet/fleet-core.js';
import { FLEET_RECONNECT_POLICY, backoffDelay, createReconnector, jitteredDelay } from '../../src/fleet/reconnect.js';
import { MAX_HANDSHAKES, START_JITTER_MS, createStaggeredStarter, type Startable } from '../../src/fleet/stagger.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { createFakeExecutor } from './fake-executor.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A link that stays `connecting` until the test settles it. */
function link(): Startable & { started: boolean; settle(status: LinkStatus): void } {
  let status: LinkStatus = 'connecting';
  const listeners = new Set<(s: LinkStatus) => void>();
  const self = {
    started: false,
    start() {
      self.started = true;
    },
    status: () => status,
    onStatus(listener: (s: LinkStatus) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    settle(next: LinkStatus) {
      status = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
  return self;
}

describe('the staggered start', () => {
  it('runs at most 8 handshakes at once over 100 hosts, counted with a fake clock', async () => {
    const starter = createStaggeredStarter({ random: () => 0.5 });
    const links = Array.from({ length: 100 }, () => link());
    links.forEach((l, i) => starter.enqueue(`host-${i}`, l));
    let maxInFlight = starter.inFlight();
    expect(links.filter((l) => l.started)).toHaveLength(MAX_HANDSHAKES);
    for (let round = 0; round < 40 && links.some((l) => !l.started || l.status() === 'connecting'); round += 1) {
      for (const l of links.filter((item) => item.started && item.status() === 'connecting')) l.settle(round % 2 === 0 ? 'online' : 'offline');
      await vi.advanceTimersByTimeAsync(START_JITTER_MS);
      maxInFlight = Math.max(maxInFlight, starter.inFlight());
      expect(starter.inFlight()).toBeLessThanOrEqual(MAX_HANDSHAKES);
    }
    expect(links.every((l) => l.started)).toBe(true);
    expect(maxInFlight).toBe(MAX_HANDSHAKES);
  });

  it('a waiting start goes after a 0-2 s jitter once a slot frees, never before', async () => {
    const starter = createStaggeredStarter({ max: 1, random: () => 0.75 });
    const first = link();
    const second = link();
    starter.enqueue('a', first);
    starter.enqueue('b', second);
    expect([first.started, second.started]).toEqual([true, false]);
    first.settle('online');
    await vi.advanceTimersByTimeAsync(0.75 * START_JITTER_MS - 1);
    expect(second.started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(second.started).toBe(true);
  });

  it('a handshake that hangs frees its slot after 30 s; a cancelled host never starts', async () => {
    const starter = createStaggeredStarter({ max: 1, random: () => 0 });
    const stuck = link();
    const gone = link();
    const next = link();
    starter.enqueue('stuck', stuck);
    starter.enqueue('gone', gone);
    starter.enqueue('next', next);
    starter.cancel('gone');
    await vi.advanceTimersByTimeAsync(30_000 - 1);
    expect(next.started).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(gone.started).toBe(false);
    expect(next.started).toBe(true);
  });

  it('the fleet starts its hosts through it: 20 links, never more than 8 connecting at once', async () => {
    const executors = Array.from({ length: 20 }, () => createFakeExecutor());
    const servers = executors.map((_e, i) => ({ name: `host-${i}`, host: `host-${i}.example.com`, user: 'dev', port: 22, hostKeyFp: `SHA256:${'A'.repeat(43)}` }));
    const fleet = createFleetWith(
      { config: { servers } as never, db: openMemoryDb(), bus: createBus(), clock: createFakeClock(), log: silentLogger() },
      { local: createFakeExecutor(), build: (record) => executors[Number(record.id.split('-')[1])] ?? null },
    );
    await fleet.start();
    expect(executors.filter((e) => e.started)).toHaveLength(MAX_HANDSHAKES);
    for (const e of executors.filter((item) => item.started)) e.setStatus('online');
    await vi.advanceTimersByTimeAsync(START_JITTER_MS);
    expect(executors.filter((e) => e.started)).toHaveLength(2 * MAX_HANDSHAKES);
    await fleet.stop();
  });
});

describe('back-off jitter', () => {
  it('spreads every delay by ±20 % around the exact back-off', () => {
    expect(jitteredDelay(10_000, 0.2, () => 0)).toBe(8_000);
    expect(jitteredDelay(10_000, 0.2, () => 0.5)).toBe(10_000);
    expect(jitteredDelay(10_000, 0.2, () => 0.999_999)).toBe(12_000);
    expect(jitteredDelay(10_000, 0, () => 0)).toBe(10_000);
    expect(FLEET_RECONNECT_POLICY.jitter).toBe(0.2);
  });

  it('the fleet policy waits a jittered delay between attempts', async () => {
    const connect = vi.fn(async () => {
      throw new Error('refused');
    });
    const reconnector = createReconnector({ connect, policy: { ...FLEET_RECONNECT_POLICY, random: () => 0 } });
    reconnector.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0.8 * backoffDelay(1) - 1);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);
    reconnector.stop();
  });
});
