import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostDTO } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { ActionRecordEntry, Db, EventBus, HostsService, HubConfig, Logger, ServerConfig } from '../../src/core/contracts.js';
import { PinInvalidError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import type { LinkError, RemoteExecutor } from '../../src/fleet/executor.js';
import { createFleetWith, type DynamicFleet } from '../../src/fleet/fleet-core.js';
import { ensureFleetKey, type FleetKey } from '../../src/fleet/fleet-key.js';
import type { HostRecord } from '../../src/fleet/servers-repo.js';
import { createHostsService, type HostScanner, type KitOutcome, type LocalKit, type RemoteRunner } from '../../src/hosts/index.js';
import type { FolderFs } from '../../src/hosts/validate.js';
import { createFakeExecutor, okJson, type FakeExecutor } from '../fleet/fake-executor.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { loadedDefaults } from '../helpers/loaded-config.js';

export const PIN = '123456';
export const NOW = '2026-11-21T08:00:00.000Z';
/** Fingerprints built from parts: no scanner sees a real one. */
export const FP_SCANNED = `SHA256:${'S'.repeat(42)}0`;
export const FP_CONFIG = `SHA256:${'C'.repeat(42)}0`;
export const SID = 'a'.repeat(64);

/** A fake link that also reports why it is down and can resume(). */
export interface LinkFake extends FakeExecutor {
  err: LinkError | null;
  resumes: number;
  /** What resume() does next (the server still refuses the key, or the line was pasted and it connects). */
  onResume: () => void;
  deny(): void;
}

function linkFake(): LinkFake {
  const fake = createFakeExecutor((args) => (args[0] === 'version'
    ? okJson({ kit: '2.1.0', claude: '2.1.330', tmux: '3.4', python: '3.12.3' })
    : okJson({ ok: true })));
  const link = fake as LinkFake;
  link.err = null;
  link.resumes = 0;
  link.onResume = () => undefined;
  link.deny = () => {
    link.err = 'auth';
    fake.setStatus('offline');
  };
  Object.assign(link, {
    lastError: () => link.err,
    resume: () => {
      link.resumes += 1;
      link.err = null;
      queueMicrotask(() => link.onResume());
    },
  } satisfies Partial<RemoteExecutor>);
  return link;
}

export const GOOD_PREFLIGHT = [
  'os=Linux', 'home=/home/dev', 'user=dev', 'python=3.12', 'tmux=tmux 3.4', 'tar=yes', 'mktemp=yes', 'claude=/home/dev/.local/bin/claude',
  'claude_version=2.1.330 (Claude Code)', 'projects=yes', 'kit_alias=', 'kit_version=',
].join('\n');

export interface FakeRemote extends RemoteRunner {
  readonly calls: Array<{ readonly script: string; readonly host: string; readonly args: readonly unknown[] }>;
  preflightOut: string;
  kitResult: KitOutcome;
  keyResult: 'removed' | 'absent' | Error;
}

function fakeRemote(): FakeRemote {
  const remote: FakeRemote = {
    calls: [],
    preflightOut: GOOD_PREFLIGHT,
    kitResult: { code: 0, summary: { ok: true, action: 'install', version: '2.1.0', host_alias: 'mars', settings: '/home/dev/.claude/settings.json', backup: '/x' }, error: null },
    keyResult: 'removed',
    async preflight(host, args) {
      remote.calls.push({ script: 'preflight', host, args: [args.claudeBin, args.projectsRoot] });
      return remote.preflightOut;
    },
    async kit(host, args, payload, onLine) {
      remote.calls.push({ script: 'kit', host, args: [...args, payload.sha256] });
      onLine('copying files');
      onLine('{"ok": true, "action": "install"}');
      const uninstall = args[0] === '--uninstall';
      return uninstall ? { code: 0, summary: { ok: true, action: 'uninstall' }, error: null } : remote.kitResult;
    },
    async removeKey(host, blob) {
      remote.calls.push({ script: 'key-remove', host, args: [blob] });
      if (remote.keyResult instanceof Error) throw remote.keyResult;
      return remote.keyResult;
    },
  };
  return remote;
}

export interface FakeLocalKit extends LocalKit {
  readonly made: Array<[string, number]>;
  readonly installs: Array<{ projectsRoot: string; claudeBin: string }>;
  uninstalls: number;
}

function fakeLocalKit(dirs: string[]): FakeLocalKit {
  const known = new Set(dirs);
  const made: Array<[string, number]> = [];
  const folders: FolderFs = {
    kind: (path) => (known.has(path) ? 'dir' : null),
    realpath: (path) => path,
    mkdir(path, mode) {
      made.push([path, mode]);
      known.add(path);
    },
  };
  const kit: FakeLocalKit = {
    made, installs: [], uninstalls: 0, folders,
    home: () => '/home/me',
    user: () => 'me',
    platform: () => 'linux',
    preflight: async () => ({ python: '3.12.3', tmux: '3.4', claude: '2.1.330', missing: [] }),
    installedAlias: async () => null,
    installedVersion: async () => null,
    async install(opts, onLine) {
      kit.installs.push(opts);
      onLine('installing');
      return { ok: true, action: 'install', version: '2.1.0', host_alias: 'computer', settings: '/home/me/.claude/settings.json' };
    },
    async uninstall() {
      kit.uninstalls += 1;
      return { ok: true, action: 'uninstall' };
    },
  };
  return kit;
}

export interface Event {
  readonly type: 'hosts.changed' | 'host.job' | 'host.log';
  readonly payload: unknown;
}

export interface Rig {
  readonly db: Db;
  readonly bus: EventBus;
  readonly clock: ReturnType<typeof createFakeClock>;
  readonly fleet: DynamicFleet;
  readonly hosts: HostsService;
  readonly links: Map<string, LinkFake>;
  readonly audits: ActionRecordEntry[];
  readonly roomCalls: Array<[string, 'delete' | 'keep']>;
  readonly remote: FakeRemote;
  readonly scans: Array<{ host: string; port: number }>;
  readonly localKit: FakeLocalKit;
  readonly events: Event[];
  readonly fleetKey: FleetKey;
  /** The latest hosts.changed list. */
  lastList(): HostDTO[] | null;
  pinChecks: number;
}

export function config(over: Partial<HubConfig> = {}, servers: ServerConfig[] = []): HubConfig {
  return {
    ...loadedDefaults('/srv/hub/data'),
    servers, fleetKeyPath: '/srv/hub/data/fleet_ed25519', dataDir: '/srv/hub/data', brainDir: '/srv/hub/brain', runDir: '/srv/hub/run',
    webDir: '/srv/hub/web', webPort: 7410, publicOrigin: 'http://localhost:7410', rpId: 'localhost',
    cfTeamDomain: '', cfAccessAud: '', sessionSecret: 'a'.repeat(64), hubSocketToken: 'b'.repeat(64), claudePath: '/home/me/.local/bin/claude',
    localCtlPath: '/home/me/.luady/bin/luady-ctl', remoteCtlPath: '~/.luady/bin/luady-ctl', ...over,
  };
}

export const CEDAR: ServerConfig = { name: 'cedar', host: 'cedar.example.com', user: 'dev', port: 22, hostKeyFp: FP_CONFIG };

export function hostsRig(opts: { servers?: ServerConfig[]; dirs?: string[]; checkWaitMs?: number; scanner?: HostScanner; log?: Logger; removeUninstallMs?: number } = {}): Rig {
  const db = openMemoryDb();
  const bus = createBus();
  const clock = createFakeClock(NOW);
  const links = new Map<string, LinkFake>();
  const build = (record: HostRecord): RemoteExecutor => {
    const link = linkFake();
    links.set(record.id, link);
    return link;
  };
  const fleet = createFleetWith({ config: config({}, opts.servers ?? []), db, bus, clock, log: silentLogger() }, { local: createFakeExecutor(), build });
  const audits: ActionRecordEntry[] = [];
  const roomCalls: Array<[string, 'delete' | 'keep']> = [];
  const remote = fakeRemote();
  const scans: Array<{ host: string; port: number }> = [];
  const localKit = fakeLocalKit(opts.dirs ?? ['/home/me']);
  const events: Event[] = [];
  for (const type of ['hosts.changed', 'host.job', 'host.log'] as const) bus.on(type, (payload) => events.push({ type, payload }));
  const fleetKey = ensureFleetKey(join(mkdtempSync(join(tmpdir(), 'luady-hosts-rig-')), 'fleet_ed25519'));
  const rig: Rig = {
    db, bus, clock, fleet, links, audits, roomCalls, remote, scans, localKit, events, fleetKey, pinChecks: 0,
    lastList: () => {
      const last = events.filter((event) => event.type === 'hosts.changed').at(-1);
      return last === undefined ? null : (last.payload as { hosts: HostDTO[] }).hosts;
    },
    hosts: undefined as unknown as HostsService,
  };
  const hosts = createHostsService({
    db, bus, clock, log: opts.log ?? silentLogger(), config: { claudePath: '/home/me/.local/bin/claude' }, fleet, fleetKey,
    pin: {
      verify: async (pin) => {
        rig.pinChecks += 1;
        if (pin !== PIN) throw new PinInvalidError(4);
      },
    },
    actions: () => ({ record: (entry) => { audits.push(entry); return {} as never; } }),
    rooms: () => ({ deleteRoomsOfHost: (host, mode) => { roomCalls.push([host, mode]); } }),
    scanner: opts.scanner ?? {
      scan: async (target) => {
        scans.push({ host: target.host, port: target.port });
        return { fingerprint: FP_SCANNED, keyType: 'ssh-ed25519' };
      },
    },
    remote, localKit,
    lookup: async (host) => [{ address: host.endsWith('.example.com') ? '192.0.2.10' : '198.51.100.7', family: 4 }],
    payload: async () => ({ bytes: Buffer.from('kit'), sha256: 'f'.repeat(64), files: 1 }),
    checkWaitMs: opts.checkWaitMs ?? 200,
    ...(opts.removeUninstallMs === undefined ? {} : { removeUninstallMs: opts.removeUninstallMs }),
  });
  Object.assign(rig, { hosts });
  return rig;
}

/** Waits until the jobs of the rig finish (the job manager runs them in the background). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}
