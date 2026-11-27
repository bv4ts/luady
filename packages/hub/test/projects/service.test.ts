import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CtlProjects } from '@luady/shared';
import { openMemoryDb } from '../../src/db/open.js';
import { PROJECTS_POLL_MS, PROJECTS_REFRESH_MS, PROJECTS_RETRY_MS, createProjectsService } from '../../src/projects/service.js';
import { createFakeClock, createFakeCtl, silentLogger } from '../helpers/fakes.js';
import { createFakeFleet, serverDto } from '../fleet/fake-fleet.js';

const MEADOW_HR = {
  path: '/home/dev/projects/meadow-hr',
  name: 'meadow-hr',
  remote: 'git@github.com:example-org/meadow-hr.git',
  branch: 'main',
  commits: [{ hash: 'a1b2c3d', date: '2026-10-09T10:00:00+04:00', subject: 'feat: payroll export' }],
  stack: ['php', 'laravel'],
};
const MEADOW_SHARE = { path: '/home/dev/projects/meadow-share', name: 'meadow-share', remote: null, branch: null, commits: [], stack: ['node'] };
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type Responses = Partial<Record<'cedar' | 'birch', () => Promise<CtlProjects>>>;

function setup(responses: Responses = {}) {
  const calls = { cedar: 0, birch: 0 };
  const ctlFor = (name: 'cedar' | 'birch') =>
    createFakeCtl({
      projects: async () => {
        calls[name] += 1;
        const respond = responses[name] ?? (async () => ({ projects: [] }));
        return respond();
      },
    });
  const fleet = createFakeFleet({ cedar: ctlFor('cedar'), birch: ctlFor('birch') });
  const clock = createFakeClock('2026-10-09T12:00:00.000Z');
  const service = createProjectsService({ db: openMemoryDb(), clock, fleet, log: silentLogger() });
  return { calls, fleet, clock, service };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createProjectsService', () => {
  it('refresh stores the registry and list returns ProjectDTOs', async () => {
    const { service } = setup({ cedar: async () => ({ projects: [MEADOW_SHARE, MEADOW_HR] }) });
    await service.refresh('cedar');
    expect(service.list('cedar')).toEqual([
      {
        server: 'cedar',
        path: MEADOW_HR.path,
        name: 'meadow-hr',
        remote: MEADOW_HR.remote,
        branch: 'main',
        commits: MEADOW_HR.commits,
        stack: ['php', 'laravel'],
        updatedAt: '2026-10-09T12:00:00.000Z',
      },
      {
        server: 'cedar',
        path: MEADOW_SHARE.path,
        name: 'meadow-share',
        remote: null,
        branch: null,
        commits: [],
        stack: ['node'],
        updatedAt: '2026-10-09T12:00:00.000Z',
      },
    ]);
  });

  it("refresh replaces only that server's rows", async () => {
    let cedarProjects = [MEADOW_HR, MEADOW_SHARE];
    const { service } = setup({
      cedar: async () => ({ projects: cedarProjects }),
      birch: async () => ({ projects: [{ ...MEADOW_SHARE, path: '/home/dev/projects/orchard', name: 'orchard' }] }),
    });
    await service.refresh('cedar');
    await service.refresh('birch');
    cedarProjects = [MEADOW_HR];
    await service.refresh('cedar');
    expect(service.list('cedar').map((project) => project.name)).toEqual(['meadow-hr']);
    expect(service.list().map((project) => `${project.server}/${project.name}`)).toEqual(['birch/orchard', 'cedar/meadow-hr']);
  });

  it('start refreshes online servers and skips offline ones', async () => {
    const { service, fleet, calls } = setup();
    fleet.setServers([serverDto('cedar', 'online'), serverDto('birch', 'offline')]);
    service.start();
    await settle();
    expect(calls).toEqual({ cedar: 1, birch: 0 });
    service.stop();
  });

  it('refreshes a server when it comes online and again after six hours', async () => {
    const { service, fleet, calls, clock } = setup();
    fleet.setServers([serverDto('cedar', 'online'), serverDto('birch', 'offline')]);
    service.start();
    await settle();
    fleet.setServers([serverDto('cedar', 'online'), serverDto('birch', 'online')]);
    await vi.advanceTimersByTimeAsync(PROJECTS_POLL_MS);
    await settle();
    expect(calls).toEqual({ cedar: 1, birch: 1 });
    clock.advance(PROJECTS_REFRESH_MS);
    await vi.advanceTimersByTimeAsync(PROJECTS_POLL_MS);
    await settle();
    expect(calls).toEqual({ cedar: 2, birch: 2 });
    service.stop();
  });

  it('logs refresh failures and retries after ten minutes', async () => {
    let fail = true;
    const { service, fleet, calls, clock } = setup({
      cedar: async () => {
        if (fail) throw new Error('luady-ctl projects failed');
        return { projects: [MEADOW_HR] };
      },
    });
    fleet.setServers([serverDto('cedar', 'online')]);
    service.start();
    await settle();
    expect(calls.cedar).toBe(1);
    expect(service.list()).toEqual([]);
    fail = false;
    await vi.advanceTimersByTimeAsync(PROJECTS_POLL_MS);
    await settle();
    expect(calls.cedar).toBe(1);
    clock.advance(PROJECTS_RETRY_MS);
    await vi.advanceTimersByTimeAsync(PROJECTS_POLL_MS);
    await settle();
    expect(calls.cedar).toBe(2);
    expect(service.list('cedar')).toHaveLength(1);
    service.stop();
  });
});
