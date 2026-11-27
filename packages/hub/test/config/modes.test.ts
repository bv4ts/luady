import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkModes, enforceModes, guardedVerdict, ownedDirs, ownedFiles } from '../../src/config/modes.js';
import { StartupRefusal } from '../../src/config/refusals.js';
import type { HubConfig } from '../../src/core/contracts.js';
import { createCaptureLogger } from '../security/capture-logger.js';

const { join } = posix;
const POSIX = process.platform !== 'win32';
const modeOf = (path: string): number => statSync(path).mode & 0o777;

function layout(): { config: HubConfig; secretsPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'luady-modes-'));
  const dataDir = join(root, 'data');
  const config = {
    dataDir, brainDir: join(root, 'brain'), runDir: join(root, 'run'), managerHome: join(dataDir, 'manager-home'),
    fleetKeyPath: join(dataDir, 'fleet_ed25519'), servers: [],
  } as unknown as HubConfig;
  return { config, secretsPath: join(root, 'secrets.env'), root };
}

describe('owned paths', () => {
  it('lists the six folders and the owner-only files', () => {
    const { config, secretsPath } = layout();
    expect(ownedDirs(config)).toEqual([
      config.dataDir, config.brainDir, config.runDir, join(config.dataDir, 'manager-home'), join(config.dataDir, 'addons'), join(config.dataDir, 'outbox'),
    ]);
    expect(ownedFiles(config, secretsPath)).toEqual([
      join(config.dataDir, 'hub.db'), join(config.dataDir, 'hub.db-wal'), join(config.dataDir, 'hub.db-shm'), secretsPath,
      config.fleetKeyPath, join(config.dataDir, 'hub-token'),
    ]);
  });

  it('counts add-on tokens as owned files once they exist', () => {
    const { config, secretsPath } = layout();
    mkdirSync(join(config.dataDir, 'addons'), { recursive: true });
    writeFileSync(join(config.dataDir, 'addons', 'chat-link.token'), 'x');
    writeFileSync(join(config.dataDir, 'addons', 'notes.txt'), 'x');
    expect(ownedFiles(config, secretsPath)).toContain(join(config.dataDir, 'addons', 'chat-link.token'));
    expect(ownedFiles(config, secretsPath)).not.toContain(join(config.dataDir, 'addons', 'notes.txt'));
  });

  it('reports nothing on Windows, where there are no Unix modes', () => {
    const { config, secretsPath } = layout();
    expect(checkModes(config, { secretsPath, platform: 'win32' })).toEqual([]);
  });

  it('on Windows it logs one clear warning that file modes are not enforced, however often it runs', () => {
    const { config, secretsPath } = layout();
    const { log, lines } = createCaptureLogger();
    enforceModes(config, { secretsPath, platform: 'win32', log });
    enforceModes(config, { secretsPath, platform: 'win32', log });
    const warnings = lines.filter((line) => line.includes('not enforced on Windows'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('WSL2');
  });
});

describe('guarded paths: who may own config.json and the folders of the config and the secrets', () => {
  const HUB = 1000;
  const OTHER = 1001;
  it("the hub's own: fine, or tightened when group or others can write it", () => {
    expect(guardedVerdict(HUB, 0o644, HUB)).toBe('ok');
    expect(guardedVerdict(HUB, 0o666, HUB)).toBe('tighten');
  });

  it("root's: fine while nobody else can write it, refused when others can", () => {
    expect(guardedVerdict(0, 0o755, HUB)).toBe('ok');
    expect(guardedVerdict(0, 0o775, HUB)).toBe('refuse-writable');
  });

  it("any other user's is refused whatever its mode: that user can write it", () => {
    expect(guardedVerdict(OTHER, 0o644, HUB)).toBe('refuse-owner');
    expect(guardedVerdict(OTHER, 0o600, HUB)).toBe('refuse-owner');
    expect(guardedVerdict(OTHER, 0o666, HUB)).toBe('refuse-owner');
  });
});

describe.skipIf(!POSIX)('modes on Linux', () => {
  it('creates the folders at 0700 and leaves files it finds at 0600', () => {
    const { config, secretsPath } = layout();
    const entries = enforceModes(config, { secretsPath });
    for (const dir of ownedDirs(config)) expect(modeOf(dir)).toBe(0o700);
    writeFileSync(secretsPath, 'SESSION_SECRET=x\n', { mode: 0o600 });
    writeFileSync(join(config.dataDir, 'hub.db'), '', { mode: 0o600 });
    const after = enforceModes(config, { secretsPath });
    expect(after.filter((entry) => entry.state === 'ok').map((entry) => entry.path)).toEqual(expect.arrayContaining([secretsPath, join(config.dataDir, 'hub.db')]));
    expect(entries.every((entry) => entry.state !== 'too-wide')).toBe(true);
  });

  it('tightens a wider folder and wider files, with a warning that names the path and never a content', () => {
    const { config, secretsPath } = layout();
    enforceModes(config, { secretsPath });
    chmodSync(config.brainDir, 0o755);
    writeFileSync(secretsPath, 'SESSION_SECRET=x\n');
    chmodSync(secretsPath, 0o644);
    writeFileSync(join(config.dataDir, 'hub.db-wal'), '');
    chmodSync(join(config.dataDir, 'hub.db-wal'), 0o664);
    const { log, lines } = createCaptureLogger();
    enforceModes(config, { secretsPath, log });
    expect(modeOf(config.brainDir)).toBe(0o700);
    expect(modeOf(secretsPath)).toBe(0o600);
    expect(modeOf(join(config.dataDir, 'hub.db-wal'))).toBe(0o600);
    expect(lines.filter((line) => line.includes('tightened'))).toHaveLength(3);
    expect(lines.join('\n')).not.toContain('SESSION_SECRET');
  });

  it('refuses to start when an owned path belongs to another Unix user', () => {
    const { config, secretsPath } = layout();
    enforceModes(config, { secretsPath });
    const other = (process.getuid?.() ?? 0) + 1;
    let caught: unknown = null;
    try {
      enforceModes(config, { secretsPath, uid: other });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StartupRefusal);
    expect((caught as StartupRefusal).refusal).toBe('foreign-owner');
    expect((caught as StartupRefusal).message).toContain(config.dataDir);
  });

  it("config.json and the folders of the config and the secrets: the hub's own lose group and other write", () => {
    const { config, secretsPath, root } = layout();
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, '{}');
    chmodSync(configPath, 0o666);
    chmodSync(root, 0o777);
    enforceModes(config, { secretsPath, guarded: [configPath, root] });
    expect(modeOf(configPath)).toBe(0o644);
    expect(modeOf(root)).toBe(0o755);
  });

  // A non-root owner other than the hub's is refused as "who can change it" (the run as root still sees root's file,
  // so "others can write it").
  it('refuses a config another Unix user owns when others can write it; accepts the hub its own 0644', () => {
    const { config, secretsPath, root } = layout();
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, '{}');
    chmodSync(configPath, 0o664);
    const me = process.getuid?.() ?? 0;
    let caught: unknown = null;
    try {
      enforceModes(config, { secretsPath, guarded: [configPath], uid: me + 1 });
    } catch (err) {
      caught = err;
    }
    expect((caught as StartupRefusal).refusal).toBe('foreign-owner');
    expect((caught as StartupRefusal).message).toContain(me === 0 ? 'others can write it' : 'who can change it');
    chmodSync(configPath, 0o644);
    expect(() => enforceModes({ ...config, dataDir: join(root, 'other-data') }, { secretsPath, guarded: [configPath] })).not.toThrow();
  });

  it.skipIf(process.getuid?.() === 0)('refuses a config another non-root user owns even when nobody else can write it', () => {
    const { config, secretsPath, root } = layout();
    const configPath = join(root, 'config.json');
    writeFileSync(configPath, '{}');
    chmodSync(configPath, 0o644);
    const other = (process.getuid?.() ?? 0) + 1;
    expect(() => enforceModes(config, { secretsPath, guarded: [configPath], uid: other })).toThrow(/who can change it/);
  });

  it('checkModes changes nothing: it only reports (doctor reads it)', () => {
    const { config, secretsPath } = layout();
    enforceModes(config, { secretsPath });
    chmodSync(config.runDir, 0o750);
    const report = checkModes(config, { secretsPath });
    expect(report.find((entry) => entry.path === config.runDir)).toMatchObject({ kind: 'dir', want: 0o700, mode: 0o750, state: 'too-wide' });
    expect(report.find((entry) => entry.path === secretsPath)).toMatchObject({ kind: 'file', want: 0o600, mode: null, state: 'missing' });
    expect(modeOf(config.runDir)).toBe(0o750);
  });
});
