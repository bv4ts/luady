import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, SELF_HOST_ID, type ServerDTO } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db, HubConfig, ServerConfig } from '../../src/core/contracts.js';
import { NotFoundError, RefusedError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import type { RemoteExecutor } from '../../src/fleet/executor.js';
import { createFleet } from '../../src/fleet/fleet.js';
import { createFleetWith, type DynamicFleet } from '../../src/fleet/fleet-core.js';
import type { HostRecord } from '../../src/fleet/servers-repo.js';
import { ManagerOffError } from '../../src/luady/errors.js';
import { createHubPathGuard, hubFolders } from '../../src/security/hub-paths.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { loadedDefaults } from '../helpers/loaded-config.js';
import { createFakeExecutor, okJson, type FakeExecutor } from './fake-executor.js';

const FP = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU';
const NOW = '2026-11-21T08:00:00.000Z';
const running: DynamicFleet[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((fleet) => fleet.stop()));
});

const server = (name: string, over: Partial<ServerConfig> = {}): ServerConfig => ({
  name, host: `${name}.example.com`, user: 'dev', port: 22, hostKeyFp: FP, ...over,
});

function config(over: Partial<HubConfig> = {}): HubConfig {
  return {
    ...loadedDefaults('/srv/hub/data'),
    servers: [server('cedar'), server('birch')], fleetKeyPath: '/srv/hub/data/fleet_ed25519', dataDir: '/srv/hub/data',
    brainDir: '/srv/hub/brain', runDir: '/srv/hub/run', webDir: '/srv/hub/web', webPort: 7410, publicOrigin: 'http://localhost:7410',
    rpId: 'localhost', cfTeamDomain: '', cfAccessAud: '', sessionSecret: 'a'.repeat(64),
    hubSocketToken: 'b'.repeat(64), claudePath: '/srv/hub/bin/claude', localCtlPath: '/srv/hub/bin/luady-ctl', remoteCtlPath: '~/.luady/bin/luady-ctl',
    ...over,
  };
}

interface Rig {
  readonly fleet: DynamicFleet;
  readonly db: Db;
  readonly built: Map<string, FakeExecutor>;
  readonly self: FakeExecutor;
}

function rig(opts: { db?: Db; config?: HubConfig; selfReady?: () => boolean; selfListed?: () => boolean } = {}): Rig {
  const db = opts.db ?? openMemoryDb();
  const built = new Map<string, FakeExecutor>();
  const self = createFakeExecutor(() => okJson({ kit: '2.1.0', claude: '2.1.330', tmux: '3.4', python: '3.12.3' }));
  const build = (record: HostRecord): RemoteExecutor => {
    const executor = createFakeExecutor();
    built.set(record.id, executor);
    return executor;
  };
  const fleet = createFleetWith(
    { config: opts.config ?? config(), db, bus: createBus(), clock: createFakeClock(NOW), log: silentLogger(), selfReady: opts.selfReady, selfListed: opts.selfListed },
    { local: self, build },
  );
  running.push(fleet);
  return { fleet, db, built, self };
}

function insertWebRow(db: Db, id: string, state: 'draft' | 'pinned' | 'removed', kind: 'ssh' | 'local' = 'ssh'): void {
  db.prepare(
    `INSERT INTO servers (name, host, user, host_key_fp, status, kind, port, source, state, created_at, updated_at)
      VALUES (?, ?, 'dev', ?, 'connecting', ?, 22, 'web', ?, ?, ?)`,
  ).run(id, `${id}.example.com`, FP, kind, state, NOW, NOW);
}

const row = (db: Db, id: string) => db.prepare('SELECT * FROM servers WHERE name = ?').get(id) as Record<string, unknown> | undefined;

describe('the dynamic fleet', () => {
  it('upserts config rows with all their columns and builds an executor for each pinned row', () => {
    const { fleet, db, built } = rig({ config: config({ servers: [server('cedar', { port: 2222, projectsRoot: '/srv/projects', fromAddr: '198.51.100.7' })] }) });
    expect([...built.keys()]).toEqual(['cedar']);
    expect(row(db, 'cedar')).toMatchObject({
      kind: 'ssh', port: 2222, projects_root: '/srv/projects', from_addr: '198.51.100.7', source: 'config', state: 'pinned', created_at: NOW,
      updated_at: NOW, removed_at: null,
    });
    expect(fleet.servers().map((s: ServerDTO) => s.name)).toEqual(['cedar']);
    expect(fleet.hostInfo('cedar')).toEqual({ id: 'cedar', kind: 'ssh', projectsRoot: '/srv/projects', homeDir: '/home/dev', terminal: true });
  });

  it('a host whose row names no projects folder starts its sessions in projects under its own home', () => {
    const { fleet } = rig({ config: config({ servers: [server('mars', { user: 'mars' }), server('cedar', { homeDir: '/data/cedar' })] }) });
    expect(fleet.hostInfo('mars')?.projectsRoot).toBe('/home/mars/projects');
    expect(fleet.hostInfo('cedar')?.projectsRoot).toBe('/data/cedar/projects');
  });

  it('adds, replaces and removes hosts at run time, reading each row itself', async () => {
    const { fleet, db, built } = rig();
    await fleet.start();
    insertWebRow(db, 'ash', 'pinned');
    fleet.addHost('ash');
    const first = built.get('ash');
    expect(first?.started).toBe(true);
    expect(fleet.hasServer('ash')).toBe(true);
    expect(fleet.hosts()).toEqual(['cedar', 'birch', 'ash', SELF_HOST_ID]);
    db.prepare("UPDATE servers SET host = 'ash2.example.com' WHERE name = 'ash'").run();
    await fleet.replaceHost('ash');
    expect(first?.closed).toBe(true);
    expect(built.get('ash')).not.toBe(first);
    expect(built.get('ash')?.started).toBe(true);
    await fleet.removeHost('ash');
    expect(built.get('ash')?.closed).toBe(true);
    expect(fleet.hasServer('ash')).toBe(false);
    expect(() => fleet.client('ash')).toThrow(NotFoundError);
    expect(fleet.link('ash')).toBeNull();
  });

  it('a config row that left the file becomes removed, and gets no executor at the next start', () => {
    const db = openMemoryDb();
    rig({ db });
    const second = rig({ db, config: config({ servers: [server('cedar')] }) });
    expect(row(db, 'birch')).toMatchObject({ source: 'config', state: 'removed', removed_at: NOW });
    expect([...second.built.keys()]).toEqual(['cedar']);
    expect(second.fleet.hasServer('birch')).toBe(false);
    expect(second.fleet.lastSync()?.removed).toEqual(['birch']);
  });

  it('skips a file entry whose id belongs to a host added on the website, and never rewrites that row', () => {
    const db = openMemoryDb();
    insertWebRow(db, 'birch', 'pinned');
    const { fleet } = rig({ db });
    expect(fleet.lastSync()?.collisions).toEqual(['birch']);
    expect(row(db, 'birch')).toMatchObject({ source: 'web', host: 'birch.example.com' });
    expect(fleet.hasServer('birch')).toBe(true);
  });

  it('draft and removed rows get no executor, and addHost refuses them', () => {
    const db = openMemoryDb();
    insertWebRow(db, 'ash', 'draft');
    insertWebRow(db, 'elm', 'removed');
    const { fleet, built } = rig({ db, config: config({ servers: [] }) });
    expect([...built.keys()]).toEqual([]);
    expect(fleet.hosts()).toEqual([SELF_HOST_ID]);
    expect(() => fleet.addHost('ash')).toThrow(RefusedError);
    expect(() => fleet.addHost('elm')).toThrow(RefusedError);
    expect(() => fleet.addHost('nowhere')).toThrow(RefusedError);
  });

  it('hasServer counts pinned SSH rows, hasLocal the local row, hasHost adds the self host', () => {
    const { fleet } = rig({ config: config({ servers: [server('cedar')], localHost: { projectsRoot: '/home/dev/projects' } }) });
    expect(fleet.hasServer('cedar')).toBe(true);
    expect(fleet.hasServer(LOCAL_HOST_ID)).toBe(false);
    expect(fleet.hasLocal(LOCAL_HOST_ID)).toBe(true);
    expect(fleet.hasLocal('cedar')).toBe(false);
    expect(fleet.hasHost(SELF_HOST_ID)).toBe(true);
    expect(fleet.hasServer(SELF_HOST_ID)).toBe(false);
    expect(fleet.hasHost('birch')).toBe(false);
  });
});

describe('fleet.servers() at scale (counted in queries issued, not time)', () => {
  /** The database with every read of the servers table counted. */
  function counting(db: Db): { db: Db; reads: () => number } {
    let reads = 0;
    const wrapped = new Proxy(db, {
      get(target, key, receiver) {
        if (key !== 'prepare') return Reflect.get(target, key, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!/^\s*SELECT[\s\S]*FROM servers/i.test(sql)) return statement;
          return new Proxy(statement, {
            get(stmt, name, r) {
              const value = Reflect.get(stmt, name, r) as unknown;
              if ((name !== 'get' && name !== 'all') || typeof value !== 'function') return value;
              return (...args: unknown[]) => {
                reads += 1;
                return (value as (...a: unknown[]) => unknown).apply(stmt, args);
              };
            },
          });
        };
      },
    });
    return { db: wrapped, reads: () => reads };
  }

  it.each([3, 60])('reads the rows of %i hosts with one query', (n) => {
    const base = openMemoryDb();
    for (let i = 0; i < n; i += 1) insertWebRow(base, `site-${String(i).padStart(2, '0')}`, 'pinned');
    const { db, reads } = counting(base);
    const { fleet } = rig({ db, config: config({ servers: [] }) });
    const before = reads();
    const servers = fleet.servers();
    expect(servers).toHaveLength(n);
    expect(servers[0]?.name).toBe('site-00');
    expect(reads() - before).toBe(1);
  });
});

describe('the local host ("this computer")', () => {
  it('a local row gets a LocalExecutor: always online, no web terminal, the user\'s own kit', async () => {
    const db = openMemoryDb();
    const fleet = createFleet({
      config: config({ servers: [], localHost: { projectsRoot: '/home/dev/projects' } }), db, bus: createBus(), clock: createFakeClock(NOW), log: silentLogger(),
    });
    running.push(fleet);
    await fleet.start();
    expect(row(db, LOCAL_HOST_ID)).toMatchObject({ kind: 'local', host: 'localhost', source: 'config', state: 'pinned', projects_root: '/home/dev/projects' });
    expect(fleet.link(LOCAL_HOST_ID)).toBe('online');
    // The local row names no home: the hub user's usual one.
    expect(fleet.hostInfo(LOCAL_HOST_ID)).toEqual({
      id: LOCAL_HOST_ID, kind: 'local', projectsRoot: '/home/dev/projects', homeDir: expect.stringMatching(/^\/(root|home\/.+)$/), terminal: false,
    });
    expect(fleet.servers()).toEqual([expect.objectContaining({ name: LOCAL_HOST_ID, kind: 'local', terminal: false })]);
    await expect(fleet.openShell(LOCAL_HOST_ID, { cols: 80, rows: 24 })).rejects.toBeInstanceOf(RefusedError);
  });
});

describe('the hub\'s own folders on the local host', () => {
  it('its file verbs refuse them before the kit is asked; an SSH server and other paths are untouched', async () => {
    const db = openMemoryDb();
    const built = new Map<string, FakeExecutor>();
    const build = (record: HostRecord): RemoteExecutor => {
      const executor = createFakeExecutor(() => okJson({ path: '/home/dev/projects/a.md', size: 1, content: 'x', truncated: false }));
      built.set(record.id, executor);
      return executor;
    };
    const cfg = config({ servers: [server('cedar')], localHost: { projectsRoot: '/home/dev/projects' } });
    const hubPaths = createHubPathGuard(hubFolders(cfg, { configPath: '/srv/hub/config/config.json', secretsPath: '/srv/hub/config/secrets.env' }), {
      realpath: () => null, home: '/home/dev', user: 'dev',
    });
    const fleet = createFleetWith({ config: cfg, db, bus: createBus(), clock: createFakeClock(NOW), log: silentLogger() }, {
      local: createFakeExecutor(), build, hubPaths,
    });
    running.push(fleet);
    const local = fleet.client(LOCAL_HOST_ID);
    await expect(local.fileRead('/srv/hub/data/hub.db', 100)).rejects.toBeInstanceOf(RefusedError);
    await expect(local.fileGet('/srv/hub/config/secrets.env', 100)).rejects.toThrow(/belongs to the hub itself/);
    await expect(local.fileWrite('/srv/hub/data/manager-home/.claude/settings.json', '{}')).rejects.toBeInstanceOf(RefusedError);
    expect(built.get(LOCAL_HOST_ID)?.execs).toEqual([]);
    await expect(local.fileRead('/home/dev/projects/a.md', 100)).resolves.toMatchObject({ content: 'x' });
    await expect(fleet.client('cedar').fileRead('/srv/hub/data/hub.db', 100)).resolves.toMatchObject({ content: 'x' });
    expect(fleet.hubPathRefusal?.(LOCAL_HOST_ID, '/srv/hub/run/hub.sock')).toMatch(/belongs to the hub itself/);
    expect(fleet.hubPathRefusal?.(LOCAL_HOST_ID, '/home/dev/projects/a.md')).toBeNull();
    expect(fleet.hubPathRefusal?.('cedar', '/srv/hub/data/hub.db')).toBeNull();
  });
});

describe('the self host while the manager is off', () => {
  it('is not a host to tail, reconcile or sign in to, and no call reaches its executor', async () => {
    let ready = false;
    const { fleet, self } = rig({ selfReady: () => ready });
    await fleet.start();
    expect(fleet.hosts()).toEqual(['cedar', 'birch']);
    await expect(fleet.client(SELF_HOST_ID).version()).rejects.toBeInstanceOf(ManagerOffError);
    await expect(fleet.client(SELF_HOST_ID).authStatus()).rejects.toBeInstanceOf(ManagerOffError);
    const tail = fleet.tailEvents(SELF_HOST_ID, 'end', () => undefined);
    await tail.done;
    expect(self.execs).toEqual([]);
    expect(self.streams).toEqual([]);
    ready = true;
    expect(fleet.hosts()).toEqual(['cedar', 'birch', SELF_HOST_ID]);
    await fleet.client(SELF_HOST_ID).version();
    expect(self.execs.map((call) => call.args[0])).toEqual(['version']);
  });

  it('switched on but still bootstrapping: listed (its tail retries), yet every call is refused until it is ready', async () => {
    let ready = false;
    const { fleet, self } = rig({ selfReady: () => ready, selfListed: () => true });
    expect(fleet.hosts()).toContain(SELF_HOST_ID);
    await fleet.tailEvents(SELF_HOST_ID, 'end', () => undefined).done;
    await expect(fleet.client(SELF_HOST_ID).sessions()).rejects.toBeInstanceOf(ManagerOffError);
    expect([self.execs, self.streams]).toEqual([[], []]);
    ready = true;
    fleet.tailEvents(SELF_HOST_ID, 'end', () => undefined);
    expect(self.streams.map((stream) => stream.args)).toEqual([['tail-events', '--from', 'end']]);
  });
});
