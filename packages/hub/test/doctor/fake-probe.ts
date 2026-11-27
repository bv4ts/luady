import { openMemoryDb } from '../../src/db/open.js';
import type { ConfigPaths } from '../../src/config/load.js';
import type { Db, HubConfig } from '../../src/core/contracts.js';
import type { DoctorInput, DoctorProbe, ExecResult, FileFacts } from '../../src/doctor/types.js';
import type { HubStatus } from '../../src/wire/status.js';
import { loadedDefaults } from '../helpers/loaded-config.js';

/** Markers that must never reach doctor's output, whatever the mode: secrets, a page key, a phone and an e-mail. */
export const SECRET_MARKERS = ['SECRET-SESSION-VALUE', 'SECRET-HUB-TOKEN-VALUE', 'SECRET-AUD-VALUE', 'PAGEKEY-VALUE'] as const;
export const PRIVATE_MARKERS = ['447700900001', 'owner@example.com', 'dev@192.0.2.13', '/home/someone'] as const;

export const CONFIG: HubConfig = {
  ...loadedDefaults('/home/someone/.local/share/luady/data'),
  servers: [{ name: 'cedar', host: '192.0.2.13', user: 'dev', port: 22, hostKeyFp: 'SHA256:abc' }],
  fleetKeyPath: '/home/someone/.local/share/luady/data/fleet_ed25519', dataDir: '/home/someone/.local/share/luady/data',
  brainDir: '/home/someone/.local/share/luady/brain', runDir: '/home/someone/.local/share/luady/run',
  webDir: '/home/someone/luady/packages/web/dist', webPort: 7410, publicOrigin: 'http://localhost:7410', rpId: 'localhost',
  ownerPhone: '447700900001', ownerEmail: 'owner@example.com', cfTeamDomain: '', cfAccessAud: 'SECRET-AUD-VALUE',
  sessionSecret: 'SECRET-SESSION-VALUE', hubSocketToken: 'SECRET-HUB-TOKEN-VALUE', claudePath: '/home/someone/.local/bin/claude',
  localCtlPath: '/home/someone/.luady/bin/luady-ctl', remoteCtlPath: '~/.luady/bin/luady-ctl', authMode: 'local', bindHost: '127.0.0.1',
  managerHome: '/home/someone/.local/share/luady/data/manager-home',
};

export const PATHS: ConfigPaths = {
  configPath: '/home/someone/.config/luady/config.json', secretsPath: '/home/someone/.config/luady/secrets.env',
  configIsDefault: true, secretsIsDefault: true,
};

const MANAGER_CTL = '/home/someone/.local/share/luady/data/manager-home/.luady/bin/luady-ctl';

export function status(over: Partial<HubStatus> = {}): HubStatus {
  return {
    at: '2026-11-21T08:00:00.000Z', authMode: 'local', remote: false,
    manager: {
      switch: 'off', state: 'off',
      bootstrap: { state: 'idle', steps: [{ id: 'folders', state: 'skipped', detail: 'manager off' }], kit: { path: MANAGER_CTL, version: null, alias: null }, finishedAt: null },
    },
    hosts: [{ id: 'cedar', kind: 'ssh', link: 'online', kitVersion: '2.1.0', kitAlias: 'cedar', claudeVersion: '2.1.300', lastError: null }],
    configSync: { collisions: [], removed: [] }, addons: [], modes: [],
    ...over,
  };
}

export const MANAGER_ON: HubStatus['manager'] = {
  switch: 'on', state: 'running',
  bootstrap: {
    state: 'done', finishedAt: '2026-11-21T08:00:00.000Z', kit: { path: MANAGER_CTL, version: '2.1.0', alias: 'hq' },
    steps: (['folders', 'brain', 'render', 'token', 'kit', 'trust'] as const).map((id) => ({ id, state: 'done' as const, detail: null })),
  },
};

const file = (mode = 0o600, executable = false): FileFacts => ({ isFile: true, isDir: false, mode, executable });
const dir = (): FileFacts => ({ isFile: false, isDir: true, mode: 0o700, executable: false });

export interface FakeProbe extends DoctorProbe {
  files: Map<string, FileFacts>;
  texts: Map<string, string>;
  runs: Map<string, ExecResult>;
  hub: HubStatus | null;
  free: boolean;
  node: string;
  os: NodeJS.Platform;
}

/** A healthy Linux machine with a running hub, the manager off; each part can be changed per test. */
export function fakeProbe(): FakeProbe {
  const files = new Map<string, FileFacts>([
    ['/home/someone/luady/packages/web/dist/index.html', file(0o644)],
    ['/home/someone/.local/bin/claude', file(0o755, true)],
    [CONFIG.fleetKeyPath, file()],
    [MANAGER_CTL, file(0o700, true)],
    ['/home/someone/.local/share/luady/data/manager-home/tmux', dir()],
  ]);
  const texts = new Map<string, string>([
    ['/home/someone/.local/share/luady/data/manager-home/.luady/state/config.json', JSON.stringify({ host_alias: 'hq' })],
  ]);
  const runs = new Map<string, ExecResult>([
    ['tmux -V', { code: 0, stdout: 'tmux 3.4\n', stderr: '' }],
    ['python3 --version', { code: 0, stdout: 'Python 3.12.3\n', stderr: '' }],
    [`${MANAGER_CTL} version`, { code: 0, stdout: JSON.stringify({ kit: '2.1.0', claude: '2.1.300' }), stderr: '' }],
    [`${MANAGER_CTL} auth-status`, { code: 0, stdout: JSON.stringify({ logged_in: true }), stderr: '' }],
  ]);
  const probe: FakeProbe = {
    files, texts, runs, hub: status(), free: true, node: '22.22.3', os: 'linux',
    nodeVersion: () => probe.node,
    platform: () => probe.os,
    stat: (path) => probe.files.get(path) ?? null,
    readText: (path) => probe.texts.get(path) ?? null,
    exec: async (cmd, args) => probe.runs.get([cmd, ...args].join(' ')) ?? { code: null, stdout: '', stderr: 'not found' },
    portFree: async () => probe.free,
    status: async () => probe.hub,
  };
  return probe;
}

export function input(probe: DoctorProbe, over: Partial<DoctorInput> = {}, db: Db | null = null): DoctorInput {
  return { paths: PATHS, config: CONFIG, configError: null, db, dbError: db === null ? 'there is no database yet' : null, probe, ...over };
}

/** A database of an install that finished its first run (a PIN is set; doctor never checks its hash). */
export function setUpDb(): Db {
  const db = openMemoryDb();
  db.prepare("UPDATE pin_state SET hash = 'set' WHERE id = 1").run();
  db.prepare("UPDATE setup_state SET step = 'done', completed_at = updated_at WHERE id = 1").run();
  // The claim stored the owner's zone with the first PIN.
  db.prepare("INSERT INTO settings (key, value_json) VALUES ('owner_tz', '\"UTC\"')").run();
  return db;
}
