import { afterEach, describe, expect, it } from 'vitest';
import type { HostId } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createIngester } from '../../src/ingest/ingester.js';
import { createFakeFleet } from '../fleet/fake-fleet.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';

const NOW = '2026-11-21T08:00:00.000Z';
const stops: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
});

/** An ingester over a host list the test changes, as the fleet's would change. */
function rig(initial: readonly HostId[]) {
  let hosts: readonly HostId[] = initial;
  const bus = createBus();
  const fleet = createFakeFleet();
  const ingester = createIngester({ db: openMemoryDb(), bus, clock: createFakeClock(NOW), fleet, log: silentLogger(), hosts: () => hosts });
  stops.push(() => ingester.stop());
  const live = (): string[] => fleet.tails.filter((tail) => !tail.stopped).map((tail) => tail.host).sort();
  return { bus, fleet, ingester, live, set: (next: readonly HostId[]) => { hosts = next; } };
}

describe('the ingester follows the fleet\'s host list while the hub runs', () => {
  it('a manager switched on later is tailed at its manager.status, and let go when it is switched off again', () => {
    const t = rig(['cedar']);
    t.ingester.start();
    expect(t.live()).toEqual(['cedar']);
    t.set(['cedar', 'hq']);
    t.bus.emit('manager.status', { state: 'starting', since: NOW, claudeSessionId: null, queued: 0 });
    expect(t.live()).toEqual(['cedar', 'hq']);
    t.set(['cedar']);
    t.bus.emit('manager.status', { state: 'off', since: NOW, claudeSessionId: null, queued: 0 });
    expect(t.live()).toEqual(['cedar']);
  });

  it('a host added or removed is picked up at hosts.changed and rooms.changed, one stream per host, never two', () => {
    const t = rig(['cedar']);
    t.ingester.start();
    t.set(['cedar', 'mars']);
    t.bus.emit('hosts.changed', { hosts: [], at: NOW });
    t.bus.emit('rooms.changed', { rooms: [], at: NOW });
    expect(t.live()).toEqual(['cedar', 'mars']);
    expect(t.fleet.tails.filter((tail) => tail.host === 'mars')).toHaveLength(1);
    t.set(['mars']);
    t.bus.emit('rooms.changed', { rooms: [], at: NOW });
    expect(t.live()).toEqual(['mars']);
  });

  it('a stream of a host that left is not restarted when it ends; nothing is followed after stop', async () => {
    const t = rig(['cedar', 'ash']);
    t.ingester.start();
    t.set(['cedar']);
    t.ingester.refresh();
    const ash = t.fleet.tails.find((tail) => tail.host === 'ash');
    ash?.end();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.fleet.tails.filter((tail) => tail.host === 'ash')).toHaveLength(1);
    await t.ingester.stop();
    t.set(['cedar', 'mars']);
    t.bus.emit('hosts.changed', { hosts: [], at: NOW });
    expect(t.fleet.tails.some((tail) => tail.host === 'mars')).toBe(false);
  });
});
