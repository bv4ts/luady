import { describe, expect, it, vi } from 'vitest';
import { FleetHistoryDTOSchema, type AccountDTO, type AccountsDTO, type ServerDTO } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { ACCOUNTS_READ_MIN_MS, FLEET_SAMPLE_MS, createFleetHistoryService, diskPct, memPct, thin } from '../../src/fleet-history/index.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';

const T0 = '2026-11-15T00:00:00.000Z';
const T0S = Date.parse(T0) / 1000;
const SYS = { load1: 0.42, load5: 0.3, mem_total_kb: 8_000_000, mem_avail_kb: 2_000_000, disk_free_kb: 25_000_000, uptime_s: 1 };

function server(name: ServerDTO['name'], over: Partial<ServerDTO> = {}): ServerDTO {
  return { name, host: 'x', status: 'online', lastSeenAt: T0, claudeVersion: null, kitVersion: '2.1.0', sysinfo: { ...SYS, disk_total_kb: 100_000_000 }, ...over };
}

function account(fiveHour: number | null, sevenDay: number | null): AccountDTO {
  const window = (used: number | null) => (used === null ? null : { usedPct: used, resetsAt: T0 });
  return {
    id: 'claude:org_1', provider: 'claude', email: 'owner@example.com', orgName: null, plan: 'max', hosts: [], isManager: true,
    limits: { reported: 'yes', fiveHour: window(fiveHour), sevenDay: window(sevenDay), updatedAt: T0 },
  };
}

function setup() {
  const bus = createBus();
  const clock = createFakeClock(T0);
  let servers: ServerDTO[] = [server('cedar'), server('birch', { status: 'offline' })];
  let limits: AccountDTO = account(10, 40);
  const list = vi.fn(async (): Promise<AccountsDTO> => ({ accounts: [limits], connections: [] }));
  const history = createFleetHistoryService({
    bus, clock, log: silentLogger(), fleet: { servers: () => servers }, accounts: { list },
  });
  return {
    bus, clock, history, list,
    setServers: (next: ServerDTO[]) => { servers = next; },
    setLimits: (next: AccountDTO) => { limits = next; },
  };
}

describe('fleet numbers', () => {
  it('memory and disk in use; disk unknown without the disk size', () => {
    expect(memPct(SYS)).toBe(75);
    expect(diskPct({ ...SYS, disk_total_kb: 100_000_000 })).toBe(75);
    expect(diskPct(SYS)).toBeNull();
    expect(diskPct({ ...SYS, disk_total_kb: 0 })).toBeNull();
    expect(memPct({ ...SYS, mem_total_kb: 0 })).toBeNull();
  });

  it('thinning keeps at most max points, spread evenly, first and last kept', () => {
    const points = Array.from({ length: 1440 }, (_, i) => i);
    const thinned = thin(points, 240);
    expect(thinned).toHaveLength(240);
    expect(thinned[0]).toBe(0);
    expect(thinned.at(-1)).toBe(1439);
    expect(new Set(thinned).size).toBe(240);
    expect(thin([1, 2, 3], 240)).toEqual([1, 2, 3]);
  });
});

describe('the fleet wall', () => {
  it('samples online servers once a minute, keeps 24 hours and answers at most 240 points', async () => {
    const t = setup();
    for (let i = 0; i < 26 * 60; i += 1) {
      t.history.sample();
      t.clock.advance(FLEET_SAMPLE_MS);
    }
    const dto = FleetHistoryDTOSchema.parse(t.history.history());
    const cedar = dto.servers.find((s) => s.name === 'cedar');
    expect(cedar?.points).toHaveLength(240);
    expect(cedar?.points[0]).toEqual([Math.floor(Date.parse('2026-11-15T02:00:00.000Z') / 1000), 0.4, 75, 75]);
    expect(dto.servers.find((s) => s.name === 'birch')?.points).toEqual([]);
  });

  it('an older kit gives no disk value (null, not 0)', () => {
    const t = setup();
    t.setServers([server('ash', { sysinfo: SYS })]);
    t.history.sample();
    expect(t.history.history().servers[0]?.points[0]?.[3]).toBeNull();
  });

  it('adds an account point only when its limits change, read at most every 30 seconds', async () => {
    const t = setup();
    await t.history.readAccounts();
    await t.history.readAccounts();
    t.setLimits(account(11, 40));
    await t.history.readAccounts();
    t.setLimits(account(null, null));
    await t.history.readAccounts();
    const dto = FleetHistoryDTOSchema.parse(t.history.history());
    expect(dto.accounts).toEqual([{ id: 'claude:org_1', label: 'owner@example.com', points: [
      [T0S, 10, 40], [T0S, 11, 40], [T0S, null, null],
    ] }]);

    t.history.start();
    await vi.waitFor(() => expect(t.list).toHaveBeenCalledTimes(5));
    t.bus.emit('accounts.changed', { at: T0 });
    t.bus.emit('accounts.changed', { at: T0 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(t.list).toHaveBeenCalledTimes(5);
    t.clock.advance(ACCOUNTS_READ_MIN_MS);
    t.bus.emit('accounts.changed', { at: T0 });
    await vi.waitFor(() => expect(t.list).toHaveBeenCalledTimes(6));
    t.history.stop();
  });
});
