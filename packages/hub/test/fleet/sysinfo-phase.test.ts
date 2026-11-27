import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SYSINFO_IN_FLIGHT, SYSINFO_PERIOD_TICKS, createPhaseScheduler, phaseOf } from '../../src/fleet/sysinfo-phase.js';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

const ids = (n: number): string[] => Array.from({ length: n }, (_v, i) => `host-${String(i).padStart(3, '0')}`);

/** Reads that stay in flight until released, counted. */
function reads() {
  let inFlight = 0;
  let maxInFlight = 0;
  const calls: string[] = [];
  const pending: Array<() => void> = [];
  const run = (id: string): Promise<void> => {
    calls.push(id);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<void>((resolve) => {
      pending.push(() => {
        inFlight -= 1;
        resolve();
      });
    });
  };
  const releaseAll = async (): Promise<void> => {
    while (pending.length > 0) {
      for (const done of pending.splice(0)) done();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return { run, calls, releaseAll, max: () => maxInFlight };
}

describe('sysinfo phases', () => {
  it('every host has its own second within the minute, stable for its id', () => {
    const phases = ids(100).map((id) => phaseOf(id));
    expect(phases.every((p) => p >= 0 && p < SYSINFO_PERIOD_TICKS)).toBe(true);
    expect(phaseOf('cedar')).toBe(phaseOf('cedar'));
    expect(new Set(phases).size).toBeGreaterThan(30);
  });

  it('reads each of 100 hosts once per minute, at most 8 in flight, counted with a fake clock', async () => {
    const r = reads();
    const scheduler = createPhaseScheduler({ hosts: () => ids(100), run: r.run });
    scheduler.start();
    for (let second = 0; second < SYSINFO_PERIOD_TICKS; second += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(scheduler.inFlight()).toBeLessThanOrEqual(MAX_SYSINFO_IN_FLIGHT);
      // Half the reads answer at once, the rest stay out a while: a slow server holds one slot, not all of them.
      if (second % 2 === 0) await r.releaseAll();
    }
    await r.releaseAll();
    await Promise.resolve();
    expect([...r.calls].sort()).toEqual(ids(100));
    expect(r.max()).toBeLessThanOrEqual(MAX_SYSINFO_IN_FLIGHT);
    scheduler.stop();
  });

  it('a host that is still being read is not queued again; hosts are read again from the list at every tick', async () => {
    let hosts = ['cedar'];
    const r = reads();
    const scheduler = createPhaseScheduler({ hosts: () => hosts, run: r.run });
    for (let tick = 0; tick < 2 * SYSINFO_PERIOD_TICKS; tick += 1) scheduler.tick();
    expect(r.calls).toEqual(['cedar']);
    await r.releaseAll();
    hosts = ['cedar', 'birch'];
    for (let tick = 0; tick < SYSINFO_PERIOD_TICKS; tick += 1) scheduler.tick();
    expect([...r.calls].sort()).toEqual(['birch', 'cedar', 'cedar']);
  });
});
