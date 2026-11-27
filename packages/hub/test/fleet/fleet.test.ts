import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerDTO, HostId } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db, Fleet, HubConfig } from '../../src/core/contracts.js';
import { NotFoundError, ValidationError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { buildCommandLine } from '../../src/fleet/command-line.js';
import type { ExecResult, RemoteExecutor } from '../../src/fleet/executor.js';
import { createFleet } from '../../src/fleet/fleet.js';
import { createFleetWith } from '../../src/fleet/fleet-core.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { createFakeExecutor, okJson } from './fake-executor.js';
import { loadedDefaults } from '../helpers/loaded-config.js';
import { startSshFixture } from './ssh-server-fixture.js';

const FP = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU';
const CTL = '~/.luady/bin/luady-ctl';
const VERSION = { kit: '1.2.0', claude: '2.1.295', tmux: '3.4', python: '3.12.3' };
const SYSINFO = { load1: 0.4, load5: 0.3, mem_total_kb: 8_000_000, mem_avail_kb: 4_000_000, disk_free_kb: 5_700_000, uptime_s: 3600 };
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const running: Fleet[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(running.splice(0).map((fleet) => fleet.stop()));
});

function hubConfig(over: Partial<HubConfig> = {}): HubConfig {
  return {
    ...loadedDefaults('/home/luady/data'),
    servers: [{ name: 'cedar', host: '192.0.2.13', user: 'dev', port: 22, hostKeyFp: FP }],
    fleetKeyPath: '/home/luady/.ssh/id_ed25519_fleet',
    dataDir: '/home/luady/data',
    brainDir: '/home/luady/brain',
    runDir: '/home/luady/run',
    webDir: '/home/luady/app/current/packages/web/dist',
    webPort: 7410,
    publicOrigin: 'https://luady.example.com',
    rpId: 'luady.example.com',
    ownerPhone: '447700900001',
    ownerEmail: 'owner@example.com',
    cfTeamDomain: 'team.cloudflareaccess.com',
    cfAccessAud: 'a'.repeat(64),
    sessionSecret: 'b'.repeat(64),
    hubSocketToken: 'c'.repeat(64),
    claudePath: '/home/luady/.local/bin/claude',
    localCtlPath: '/home/luady/.luady/bin/luady-ctl',
    remoteCtlPath: CTL,
    ...over,
  };
}

function respond(args: readonly string[]): ExecResult {
  if (args[0] === 'version') return okJson(VERSION);
  if (args[0] === 'sysinfo') return okJson(SYSINFO);
  return okJson({ ok: true });
}

function setup(opts: { db?: Db; readOnly?: boolean } = {}) {
  const bus = createBus();
  const clock = createFakeClock('2026-10-09T12:00:00.000Z');
  const updates: ServerDTO[] = [];
  bus.on('server.updated', (server) => updates.push(server));
  const remote = createFakeExecutor(respond);
  const local = createFakeExecutor();
  const remotes = new Map<HostId, RemoteExecutor>([['cedar', remote]]);
  const db = opts.db ?? openMemoryDb();
  const deps = { config: hubConfig(), db, bus, clock, log: silentLogger(), readOnly: opts.readOnly };
  const fleet = createFleetWith(deps, { remotes, local });
  running.push(fleet);
  return { clock, updates, remote, local, fleet, db };
}

describe('createFleetWith', () => {
  it('registers configured servers as connecting on start and starts their executors', async () => {
    const { fleet, updates, remote } = setup();
    await fleet.start();
    expect(remote.started).toBe(true);
    expect(updates).toEqual([expect.objectContaining({ name: 'cedar', host: '192.0.2.13', status: 'connecting' })]);
    expect(fleet.servers()).toEqual([
      {
        name: 'cedar', host: '192.0.2.13', status: 'connecting', lastSeenAt: null, claudeVersion: null, kitVersion: null, sysinfo: null,
        kind: 'ssh', projectsRoot: null, homeDir: null, terminal: true,
      },
    ]);
  });

  it('marks a server online, then reads its versions and sysinfo', async () => {
    const { fleet, updates, remote } = setup();
    await fleet.start();
    remote.setStatus('online');
    await settle();
    expect(fleet.servers()[0]).toEqual({
      name: 'cedar',
      host: '192.0.2.13',
      status: 'online',
      lastSeenAt: '2026-10-09T12:00:00.000Z',
      claudeVersion: '2.1.295',
      kitVersion: '1.2.0',
      sysinfo: SYSINFO,
      kind: 'ssh', projectsRoot: null, homeDir: null, terminal: true,
    });
    expect(remote.execs.map((call) => call.args[0])).toEqual(['version', 'sysinfo']);
    expect(updates.map((server) => server.status)).toEqual(['connecting', 'online', 'online', 'online']);
  });

  it('reports offline servers', async () => {
    const { fleet, updates, remote } = setup();
    await fleet.start();
    remote.setStatus('offline');
    expect(fleet.servers()[0]?.status).toBe('offline');
    expect(updates.at(-1)?.status).toBe('offline');
  });

  it('refreshes sysinfo every 60 s while online', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { fleet, remote } = setup();
    await fleet.start();
    remote.setStatus('online');
    await settle();
    remote.respond((args) => (args[0] === 'sysinfo' ? okJson({ ...SYSINFO, load1: 2.5 }) : respond(args)));
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(fleet.servers()[0]?.sysinfo?.load1).toBe(2.5);
    expect(remote.execs.filter((call) => call.args[0] === 'sysinfo')).toHaveLength(2);
  });

  it('repairs a server row another process reset to connecting while the link stayed up', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { fleet, remote, db, updates } = setup();
    await fleet.start();
    remote.setStatus('online');
    await settle();
    db.prepare("UPDATE servers SET status = 'connecting'").run();
    expect(fleet.servers()[0]?.status).toBe('connecting');
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(fleet.servers()[0]?.status).toBe('online');
    expect(updates.at(-1)?.status).toBe('online');
  });

  it('a read-only fleet (cli doctor) never rewrites the server rows of the running hub', async () => {
    const hub = setup();
    await hub.fleet.start();
    hub.remote.setStatus('online');
    await settle();
    const doctor = setup({ db: hub.db, readOnly: true });
    await doctor.fleet.start();
    expect(doctor.remote.started).toBe(true);
    expect(hub.fleet.servers()[0]?.status).toBe('online');
    doctor.remote.setStatus('offline');
    await doctor.fleet.stop();
    expect(hub.fleet.servers()[0]?.status).toBe('online');
    expect(doctor.updates).toEqual([]);
  });

  it('splits tail-events output into complete lines across chunk boundaries', async () => {
    const { fleet, remote } = setup();
    const lines: string[] = [];
    const handle = fleet.tailEvents('cedar', 'events-20261009.jsonl:120', (line) => lines.push(line));
    const stream = remote.streams[0];
    expect(stream?.args).toEqual(['tail-events', '--from', 'events-20261009.jsonl:120']);
    const payload = Buffer.from(
      '{"heartbeat":"2026-10-09T12:00:00Z"}\n{"file":"events-20261009.jsonl","offset":200,"event":{"text":"مرحبا"}}\n',
      'utf8',
    );
    const cut = payload.indexOf(Buffer.from('مرحبا', 'utf8')) + 1;
    stream?.push(payload.subarray(0, 20));
    stream?.push(payload.subarray(20, cut));
    stream?.push(payload.subarray(cut));
    expect(lines).toEqual(payload.toString('utf8').trimEnd().split('\n'));
    stream?.end();
    await handle.done;
  });

  it('rejects bad tail positions and unknown hosts', () => {
    const { fleet } = setup();
    expect(() => fleet.tailEvents('cedar', 'events-2026.jsonl:1; rm -rf /', () => undefined)).toThrow(ValidationError);
    expect(() => fleet.tailEvents('ash', 'end', () => undefined)).toThrow(NotFoundError);
    expect(() => fleet.client('birch')).toThrow(NotFoundError);
  });

  it('routes the luady host to the local executor and shells to the remote one', async () => {
    const { fleet, local, remote } = setup();
    await fleet.client('hq').keys('manager:0.0', 'Escape');
    expect(local.execs[0]?.args).toEqual(['keys', '--target', 'manager:0.0', '--key', 'Escape']);
    expect(remote.execs).toEqual([]);
    await fleet.openShell('cedar', { cols: 80, rows: 24, tmuxTarget: 'cc-x:0.0' });
    expect(remote.shells).toEqual([{ cols: 80, rows: 24, tmuxTarget: 'cc-x:0.0' }]);
    await expect(fleet.openShell('birch', { cols: 80, rows: 24 })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('stop() closes every executor and is idempotent', async () => {
    const { fleet, remote, local } = setup();
    await fleet.start();
    await fleet.stop();
    await fleet.stop();
    expect(remote.closed).toBe(true);
    expect(local.closed).toBe(true);
  });
});

describe('createFleet', () => {
  it('connects over SSH with the pinned host key and reads versions', async () => {
    const fixture = await startSshFixture();
    fixture.setExecHandler((call, channel) => {
      const reply =
        call.command === buildCommandLine(CTL, ['version']) ? VERSION
          : call.command === buildCommandLine(CTL, ['sysinfo']) ? SYSINFO
            : { ok: true };
      channel.write(JSON.stringify(reply));
      channel.exit(0);
      channel.end();
    });
    const config = hubConfig({
      servers: [{ name: 'cedar', host: '127.0.0.1', user: 'dev', port: fixture.port, hostKeyFp: fixture.hostKeyFp }],
      fleetKeyPath: fixture.clientKeyPath,
    });
    const fleet = createFleet({ config, db: openMemoryDb(), bus: createBus(), clock: createFakeClock(), log: silentLogger() });
    try {
      await fleet.start();
      await vi.waitFor(
        () => expect(fleet.servers()[0]).toMatchObject({ status: 'online', kitVersion: '1.2.0', claudeVersion: '2.1.295', sysinfo: SYSINFO }),
        { timeout: 5000 },
      );
      expect(fixture.execs.map((call) => call.command)).toEqual([buildCommandLine(CTL, ['version']), buildCommandLine(CTL, ['sysinfo'])]);
    } finally {
      await fleet.stop();
      await fixture.close();
    }
  });
});
