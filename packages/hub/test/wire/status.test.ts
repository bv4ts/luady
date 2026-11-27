import { afterEach, describe, expect, it } from 'vitest';
import { INTERNAL_PATHS } from '@luady/shared';
import type { App } from '../../src/app.js';
import type { HubStatus } from '../../src/wire/status.js';

/** The route's path, from the shared list. */
const STATUS_PATH = INTERNAL_PATHS.status;
import { WIRING_TOKEN, startWiring, wiringConfig } from './wiring-harness.js';

let running: App | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
});

describe('GET /internal/status', () => {
  it('reports the manager off with every bootstrap check "manager off", the hosts, add-ons and modes', async () => {
    const run = await startWiring({}, wiringConfig(), false);
    running = run.app;
    const res = await run.app.internal.inject({ method: 'GET', url: STATUS_PATH, headers: { authorization: `Bearer ${WIRING_TOKEN}` } });
    expect(res.statusCode).toBe(200);
    const status = res.json() as HubStatus;
    expect(status.manager.switch).toBe('off');
    expect(status.manager.state).toBe('off');
    expect(status.manager.bootstrap.steps.map((step) => [step.id, step.state, step.detail])).toEqual(
      ['folders', 'brain', 'render', 'token', 'kit', 'trust'].map((id) => [id, 'skipped', 'manager off']),
    );
    expect(status.manager.bootstrap.kit.path).toMatch(/manager-home\/\.luady\/bin\/luady-ctl$/);
    expect(status.hosts).toEqual([]);
    expect(status.addons).toEqual([]);
    expect(Array.isArray(status.modes)).toBe(true);
    expect(status).toMatchObject({ authMode: 'local', remote: true });
  });

  it('never carries a secret: not the hub token, the session secret or a page key', async () => {
    const run = await startWiring({}, wiringConfig(), false);
    running = run.app;
    const res = await run.app.internal.inject({ method: 'GET', url: STATUS_PATH, headers: { authorization: `Bearer ${WIRING_TOKEN}` } });
    for (const secret of [WIRING_TOKEN, run.config.sessionSecret, run.pageKey]) expect(res.body).not.toContain(secret);
  });

  it('sits behind the hub token like every internal route', async () => {
    const run = await startWiring({}, wiringConfig(), false);
    running = run.app;
    expect((await run.app.internal.inject({ method: 'GET', url: STATUS_PATH })).statusCode).toBe(401);
    expect((await run.app.internal.inject({ method: 'GET', url: STATUS_PATH, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
  });
});

describe('the fleet key is the dynamic fleet', () => {
  it('a plain fleet passed in by a test serves every call, and refuses host changes it cannot make', async () => {
    const run = await startWiring({}, wiringConfig(), false);
    running = run.app;
    const fleet = run.app.services.fleet as import('../../src/fleet/fleet-core.js').DynamicFleet;
    expect(fleet.servers()).toEqual([]);
    expect(fleet.link('cedar')).toBeNull();
    expect(fleet.lastSync()).toBeNull();
    expect(() => fleet.addHost('cedar')).toThrow(/cannot change its hosts/);
    await expect(fleet.removeHost('cedar')).rejects.toThrow(/cannot change its hosts/);
  });
});
