import { describe, expect, it } from 'vitest';
import type { RoomDTO, ServerDTO } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createHostLookups } from '../../src/fleet/host-lookups.js';
import { createRoomsService } from '../../src/rooms/index.js';
import type { WebContext } from '../../src/web/context.js';
import { buildOverview } from '../../src/web/routes/overview.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { NOW } from './helpers.js';

/**
 * Scale without small-N assumptions: 100 servers and 300 rooms. Operations are counted, never
 * timed: statements run per table, glob comparisons, bytes on the wire.
 */
const HOSTS = Array.from({ length: 100 }, (_, i) => `host-${String(i).padStart(3, '0')}`);

/** The database with every statement's runs counted by the table its SQL reads or writes. */
function counting(db: Db): { db: Db; runs: Map<string, number>; reset(): void } {
  const runs = new Map<string, number>();
  const tableOf = (sql: string): string => /\b(?:FROM|INTO|UPDATE)\s+([a-z_]+)/i.exec(sql)?.[1] ?? '?';
  const wrapped = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
      return (sql: string) => {
        const statement = target.prepare(sql);
        const table = tableOf(sql);
        return new Proxy(statement, {
          get(st, key) {
            const value = Reflect.get(st, key);
            if (typeof value !== 'function') return value;
            if (key !== 'all' && key !== 'get' && key !== 'run' && key !== 'iterate') return value.bind(st);
            return (...args: unknown[]) => {
              runs.set(table, (runs.get(table) ?? 0) + 1);
              return (value as (...a: unknown[]) => unknown).apply(st, args);
            };
          },
        });
      };
    },
  });
  return { db: wrapped, runs, reset: () => runs.clear() };
}

function bigOffice() {
  const counted = counting(openMemoryDb());
  const bus = createBus();
  let changed: Array<{ rooms: RoomDTO[] }> = [];
  bus.on('rooms.changed', (event) => changed.push(event));
  const lookups = createHostLookups(() => HOSTS.map((name) => ({ name, projectsRoot: '/srv/projects' })));
  const servers = HOSTS.map((name) => ({ name }) as ServerDTO);
  const rooms = createRoomsService({
    db: counted.db, bus, clock: createFakeClock(NOW), log: silentLogger(), fleet: { ...lookups, servers: () => servers }, changedMinMs: 0,
  });
  for (const host of HOSTS) rooms.create({ name: `Server ${host}`, kind: 'server', host });
  for (let i = 0; i < 200; i += 1) {
    rooms.create({ name: `Project ${i}`, kind: 'project', host: HOSTS[i % HOSTS.length] ?? null, match: [{ by: 'name', glob: `project-${i}*` }] });
  }
  return { rooms, counted, servers, changed: () => changed, clear: () => { changed = []; } };
}

describe('rooms at scale: 100 servers, 300 rooms', () => {
  it('the overview reads the rooms with one query per table, whatever the number of rooms', () => {
    const office = bigOffice();
    const deps = {
      fleet: { servers: () => office.servers }, sessions: { list: () => [] }, questions: { pending: () => [] }, actions: { pending: () => [] },
      luady: { status: () => ({ state: 'off', since: NOW, claudeSessionId: null, queued: 0 }) },
      rooms: office.rooms,
    };
    office.counted.reset();
    const overview = buildOverview({ deps } as unknown as WebContext);
    expect(overview.rooms).toHaveLength(300);
    expect(overview.rooms.every((room) => room.hostState === 'ok')).toBe(true);
    expect(Object.fromEntries(office.counted.runs)).toEqual({ rooms: 1, servers: 1 });
  });

  it('the grid is K=9, R=9 and one rooms.changed with all 300 rooms is at most 120 KB', () => {
    const office = bigOffice();
    expect(office.rooms.list().grid).toEqual({ slotCount: 300, K: 9, R: 9, capacity: 324 });
    const last = office.changed().at(-1);
    expect(last?.rooms).toHaveLength(300);
    const bytes = Buffer.byteLength(JSON.stringify({ type: 'rooms.changed', ...last, at: NOW }));
    expect(bytes).toBeLessThanOrEqual(120 * 1024);
  });

  it('a write costs a bounded number of statements, not one per room', () => {
    const office = bigOffice();
    office.counted.reset();
    office.rooms.create({ name: 'One more', kind: 'project', host: null, match: [{ by: 'name', glob: 'more*' }] });
    const total = [...office.counted.runs.values()].reduce((sum, n) => sum + n, 0);
    expect(total).toBeLessThanOrEqual(10);
    // A swap: the read, two passes of two rooms, and the lists it answers and announces (rooms and tombstones each).
    office.counted.reset();
    office.rooms.move('one-more', 0);
    expect([...office.counted.runs.values()].reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(10);
  });
});
