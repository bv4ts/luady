import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PAGE_KEY_HEADER, SELF_HOST_ID } from '@luady/shared';
import { createApp, type App } from '../../src/app.js';
import type { AccessVerifier, Db, HubConfig } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createFleetWith } from '../../src/fleet/fleet-core.js';
import { ManagerOffError } from '../../src/luady/errors.js';
import type { TmuxRunner } from '../../src/luady/types.js';
import { SESSION_COOKIE, createSessionStore } from '../../src/web/auth/sessions.js';
import type { ProvidedManager } from '../../src/wire/manager.js';
import { markSetUp } from '../helpers/claimed.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { loadedDefaults } from '../helpers/loaded-config.js';
import { createFakeExecutor, okJson, type FakeExecutor } from '../fleet/fake-executor.js';

const { join } = posix;
const ORIGIN = 'https://hub.example';
const TOKEN = 'd'.repeat(64);
const owner: AccessVerifier = { verify: async () => ({ email: 'owner' }) };
let running: App | null = null;

afterEach(async () => {
  await running?.stop();
  running = null;
});

function config(): HubConfig {
  const root = mkdtempSync(join(tmpdir(), 'luady-optional-'));
  mkdirSync(join(root, 'web'));
  writeFileSync(join(root, 'web', 'index.html'), '<!doctype html><title>Hub</title>');
  return {
    ...loadedDefaults(join(root, 'data')),
    servers: [], fleetKeyPath: join(root, 'fleet'), dataDir: join(root, 'data'), brainDir: join(root, 'brain'), runDir: join(root, 'run'),
    webDir: join(root, 'web'), webPort: 7410, publicOrigin: ORIGIN, rpId: 'hub.example', cfTeamDomain: '',
    cfAccessAud: '', sessionSecret: 'e'.repeat(64), hubSocketToken: TOKEN, claudePath: '/srv/hub/bin/claude',
    localCtlPath: '/srv/hub/bin/luady-ctl', remoteCtlPath: '~/.luady/bin/luady-ctl',
  };
}

/** The tmux the manager would run on: every call counted, the pane alive once a session was made. */
function countingTmux(kill: { code: number; stderr: string } = { code: 0, stderr: '' }) {
  const calls: string[][] = [];
  let alive = false;
  const runner: TmuxRunner = {
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'new-session') alive = true;
      if (args[0] === 'kill-session' && kill.code !== 0) return { code: kill.code, stdout: '', stderr: kill.stderr };
      if (args[0] === 'kill-session') alive = false;
      if (args[0] === 'has-session') return { code: alive ? 0 : 1, stdout: '', stderr: '' };
      return { code: 0, stdout: args[0] === 'display-message' ? 'claude\n' : '', stderr: '' };
    },
  };
  return { runner, calls };
}

interface Rig {
  readonly app: App;
  readonly db: Db;
  readonly self: FakeExecutor;
  readonly tmux: ReturnType<typeof countingTmux>;
  readonly headers: Record<string, string>;
  readonly manager: ProvidedManager;
}

/** The composed hub with the real dynamic fleet (its self host on a fake executor) and a counting tmux. */
async function hub(seed?: (db: Db) => void, kill?: { code: number; stderr: string }): Promise<Rig> {
  const db = openMemoryDb();
  // An owner signs in only on a set-up install (before that the hub answers sign-in and setup only).
  await markSetUp(db);
  seed?.(db);
  const cfg = config();
  const self = createFakeExecutor((args) => okJson(args[0] === 'version' ? { kit: '2.1.0', claude: '2.1.330', tmux: '3.4', python: '3.12.3' } : { ok: true }));
  let app: App | null = null;
  const fleet = createFleetWith(
    { config: cfg, db, bus: { emit: () => undefined, on: () => () => undefined } as never, clock: createFakeClock(), log: silentLogger(),
      selfReady: () => (app?.services.luady as ProvidedManager | undefined)?.managerReady() === true },
    { local: self },
  );
  const tmux = countingTmux(kill);
  app = await createApp(cfg, { db, log: silentLogger(), access: owner, tmux: tmux.runner, fleet });
  running = app;
  await app.start({ listen: false });
  const session = createSessionStore({ db, clock: { now: () => new Date() } }).create();
  const headers = {
    host: 'hub.example', cookie: `${SESSION_COOKIE}=${encodeURIComponent(app.web.signCookie(session.sid))}`,
    [PAGE_KEY_HEADER]: session.pageKey, origin: ORIGIN, 'x-hub-csrf': session.csrf,
  };
  return { app, db, self, tmux, headers, manager: app.services.luady as ProvidedManager };
}

const managerOn = (db: Db): void => {
  db.prepare("INSERT INTO settings (key, value_json) VALUES ('manager_enabled', 'true')").run();
};

describe('the manager is optional', () => {
  it('off by default: tmux is never called, the status is off, and nothing is queued for it', async () => {
    const { app, db, tmux, manager } = await hub();
    await manager.managerControl.settled();
    expect(manager.managerState()).toBe('off');
    expect(manager.managerControl.state()).toBe('off');
    // The wire DTO says `off` too, never `down`, while the switch is off.
    expect(app.services.luady.status().state).toBe('off');
    await app.services.luady.postEvent('A mission finished', 'Event');
    expect(db.prepare('SELECT COUNT(*) AS n FROM manager_queue').get()).toEqual({ n: 0 });
    expect(tmux.calls).toEqual([]);
  });

  it('off: POST /api/manager/messages answers 409 manager_off and stores nothing; the service refuses with ManagerOffError', async () => {
    const { app, db, headers } = await hub();
    const res = await app.web.inject({ method: 'POST', url: '/api/manager/messages', headers, payload: { text: 'hello' } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'manager_off' } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread = 'manager'").get()).toEqual({ n: 0 });
    await expect(app.services.luady.postOwnerMessage('hello', 'web')).rejects.toBeInstanceOf(ManagerOffError);
  });

  it('off: the self host is never polled: no sign-in check, no tail, no reconcile, no executor call', async () => {
    const { app, self, manager } = await hub();
    await app.services.login.check();
    await expect(app.services.login.begin(SELF_HOST_ID)).rejects.toBeInstanceOf(ManagerOffError);
    expect(app.services.fleet.hosts()).not.toContain(SELF_HOST_ID);
    expect(self.execs).toEqual([]);
    expect(self.streams).toEqual([]);
    expect(manager.managerControl.bootstrap().steps.every((step) => step.state === 'skipped' && step.detail === 'manager off')).toBe(true);
  });

  it('off: the switch view says off, every bootstrap check "manager off", and offers no sign-in yet', async () => {
    const { app, headers } = await hub();
    const res = await app.web.inject({ method: 'GET', url: '/api/manager/switch', headers });
    expect(res.statusCode).toBe(200);
    const view = res.json() as { enabled: boolean; state: string; steps: Array<{ state: string; detail: string }>; signIn: boolean };
    expect(view).toMatchObject({ enabled: false, state: 'off', signIn: false });
    expect(view.steps.map((step) => step.detail)).toEqual(Array(6).fill('manager off'));
  });

  it('switched on: the bootstrap runs, then the launch; the self host joins the fleet; switched off: the session ends', async () => {
    const { app, tmux, self, headers, manager } = await hub();
    app.services.settings.update({ manager_enabled: true });
    await manager.managerControl.settled();
    expect(manager.managerControl.state()).toBe('on');
    expect(tmux.calls.map((args) => args[0])).toContain('new-session');
    expect(app.services.fleet.hosts()).toContain(SELF_HOST_ID);
    const view = await app.web.inject({ method: 'GET', url: '/api/manager/switch', headers });
    expect(view.json()).toMatchObject({ enabled: true, state: 'on', signIn: true });
    await app.services.fleet.client(SELF_HOST_ID).version();
    expect(self.execs.map((call) => call.args[0])).toContain('version');
    app.services.settings.update({ manager_enabled: false });
    await manager.managerControl.settled();
    expect(manager.managerControl.state()).toBe('off');
    expect(tmux.calls.at(-1)).toEqual(['kill-session', '-t', '=manager']);
    expect(app.services.fleet.hosts()).not.toContain(SELF_HOST_ID);
  });

  it('switched off: a session that will not end is tried twice and leaves the switch failed, never a false off', async () => {
    const { app, tmux, manager } = await hub(managerOn, { code: 1, stderr: 'permission denied' });
    await manager.managerControl.settled();
    app.services.settings.update({ manager_enabled: false });
    await manager.managerControl.settled();
    expect(tmux.calls.filter((args) => args[0] === 'kill-session')).toHaveLength(2);
    expect(manager.managerControl.state()).toBe('failed');
    expect(app.services.fleet.hosts()).not.toContain(SELF_HOST_ID);
  });

  it('switched off when no session is left (tmux says so): off, after one try', async () => {
    const { app, tmux, manager } = await hub(managerOn, { code: 1, stderr: "can't find session: manager" });
    await manager.managerControl.settled();
    app.services.settings.update({ manager_enabled: false });
    await manager.managerControl.settled();
    expect(tmux.calls.filter((args) => args[0] === 'kill-session')).toHaveLength(1);
    expect(manager.managerControl.state()).toBe('off');
  });

  it('the internal tool routes follow the switch: 409 manager_off while off, answered while on, refused again once off', async () => {
    const { app, manager } = await hub();
    const tool = () => app.internal.inject({
      method: 'POST', url: '/internal/tools/fleet_status', headers: { authorization: `Bearer ${TOKEN}` }, payload: {},
    });
    const off = await tool();
    expect(off.statusCode).toBe(409);
    expect(off.json()).toMatchObject({ ok: false, code: 'manager_off' });
    app.services.settings.update({ manager_enabled: true });
    await manager.managerControl.settled();
    expect((await tool()).statusCode).toBe(200);
    app.services.settings.update({ manager_enabled: false });
    await manager.managerControl.settled();
    expect((await tool()).statusCode).toBe(409);
  });

  it('a manager session that would not end after the switch-off keeps no tools', async () => {
    const { app, manager } = await hub(managerOn, { code: 1, stderr: 'permission denied' });
    await manager.managerControl.settled();
    app.services.settings.update({ manager_enabled: false });
    await manager.managerControl.settled();
    expect(manager.managerControl.state()).toBe('failed');
    const headers = { authorization: `Bearer ${TOKEN}` };
    const call = await app.internal.inject({ method: 'POST', url: '/internal/tools/notify_user', headers, payload: { text: 'still here' } });
    const list = await app.internal.inject({ method: 'GET', url: '/internal/tools', headers });
    expect([call.statusCode, list.statusCode]).toEqual([409, 409]);
    expect(app.services.notices.list().map((notice) => notice.text)).not.toContain('still here');
  });

  it('an existing install (016 left it on) bootstraps and launches at start', async () => {
    const { tmux, manager } = await hub(managerOn);
    await manager.managerControl.settled();
    await vi.waitFor(() => expect(tmux.calls.map((args) => args[0])).toContain('new-session'));
    expect(manager.managerControl.state()).toBe('on');
    expect(manager.managerState()).not.toBe('off');
  });

  it('the remote-control name is the manager name setting', async () => {
    const { app, tmux, manager } = await hub();
    app.services.settings.update({ manager_name: 'Mira', manager_enabled: true });
    await manager.managerControl.settled();
    const launch = tmux.calls.find((args) => args[0] === 'new-session') ?? [];
    expect(launch[launch.indexOf('--remote-control') + 1]).toBe('Mira');
    app.services.settings.update({ manager_name: 'Luady' });
  });
});
