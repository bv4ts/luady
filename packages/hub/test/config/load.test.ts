import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STARTER_CONFIG } from '../../src/config/defaults.js';
import { parseEnvFile } from '../../src/config/env-file.js';
import { configPaths, loadConfig } from '../../src/config/load.js';
import { StartupRefusal, type Refusal } from '../../src/config/refusals.js';
import { ValidationError } from '../../src/core/errors.js';

/** The hub's paths are POSIX paths (config/defaults.ts); the expectations are built the same way. */
const { join } = posix;
const FP = 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU';
const AUD = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SESSION_SECRET = 'a'.repeat(64);
const HUB_TOKEN = 'b'.repeat(64);
const HEX64 = /^[a-f0-9]{64}$/;
const POSIX = process.platform !== 'win32';
const SECRETS = [
  '# Luady secrets (mode 0600)',
  `CF_ACCESS_AUD=${AUD}`,
  `SESSION_SECRET=${SESSION_SECRET}`,
  `HUB_SOCKET_TOKEN="${HUB_TOKEN}"`,
  'TWILIO_AUTH_TOKEN=not-used-here',
  '',
].join('\n');

/** An existing Access install: remote behind Cloudflare Access, so it says so. */
function accessConfig(): Record<string, unknown> {
  return {
    servers: [
      { name: 'cedar', host: '192.0.2.13', user: 'dev', port: 22, hostKeyFp: FP },
      { name: 'birch', host: '192.0.2.12', user: 'dev', port: 22, hostKeyFp: FP },
    ],
    fleetKeyPath: '/home/luady/.ssh/id_ed25519_fleet',
    dataDir: '/home/luady/data',
    brainDir: '/home/luady/brain',
    runDir: '/home/luady/run',
    webDir: '/home/luady/app/current/packages/web/dist',
    webPort: 7410,
    publicOrigin: 'https://hub.example.com',
    rpId: 'hub.example.com',
    ownerPhone: '447700900001',
    ownerEmail: 'owner@example.com',
    cfTeamDomain: 'team.cloudflareaccess.com',
    claudePath: '/home/luady/.local/bin/claude',
    localCtlPath: '/home/luady/.luady/bin/luady-ctl',
    remoteCtlPath: '~/.luady/bin/luady-ctl',
    authMode: 'cloudflare-access',
    allowRemote: true,
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'luady-config-'));
}

function writeEnv(config: unknown, secrets: string = SECRETS): NodeJS.ProcessEnv {
  const dir = tempDir();
  const configPath = join(dir, 'config.json');
  const secretsPath = join(dir, 'secrets.env');
  writeFileSync(configPath, typeof config === 'string' ? config : JSON.stringify(config));
  writeFileSync(secretsPath, secrets);
  return { LUADY_CONFIG: configPath, LUADY_SECRETS: secretsPath };
}

/** A home folder with nothing in it, and an environment that names no file: the first start of a stranger. */
function freshHome(): { home: string; env: NodeJS.ProcessEnv } {
  return { home: tempDir(), env: {} };
}

/** A fresh home whose config.json (at the default path) holds `config`. */
function homeWith(config: Record<string, unknown>): { home: string; env: NodeJS.ProcessEnv } {
  const { home, env } = freshHome();
  const { configPath } = configPaths(env, home);
  mkdirSync(join(home, '.config', 'luady'), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config));
  return { home, env };
}

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    if (err instanceof Error) return err;
  }
  throw new Error('expected the call to throw an Error');
}

function refusalOf(fn: () => unknown): Refusal {
  const error = captureError(fn);
  expect(error).toBeInstanceOf(StartupRefusal);
  expect(error.message.split('\n')).toHaveLength(1);
  return (error as StartupRefusal).refusal;
}

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe('loadConfig: an existing install', () => {
  it('loads an Access install with its secrets, keeping every value it names and defaulting the rest', () => {
    const env = writeEnv(accessConfig());
    expect(loadConfig(env, { home: tempDir(), root: '/opt/luady' })).toEqual({
      ...accessConfig(),
      managerHome: '/home/luady/data/manager-home',
      managerFiles: 'own-folder',
      addons: [],
      bindHost: '127.0.0.1',
      allowedHosts: ['hub.example.com'],
      trustedProxy: 'cloudflare',
      ownerLabel: 'owner',
      cfAccessAud: AUD,
      sessionSecret: SESSION_SECRET,
      hubSocketToken: HUB_TOKEN,
      twilio: null,
      google: null,
      imap: null,
    });
  });

  it('names the failing config field', () => {
    const config = accessConfig();
    const servers = [{ name: 'cedar', host: '192.0.2.13', user: 'dev', port: 22, hostKeyFp: 'MD5:aa:bb' }];
    expect(() => loadConfig(writeEnv({ ...config, servers }))).toThrow(/servers\.0\.hostKeyFp/);
    expect(() => loadConfig(writeEnv({ ...config, publicOrigin: 'https://hub.example.com/app' }))).toThrow(/publicOrigin/);
    expect(() => loadConfig(writeEnv({ ...config, remoteCtlPath: '~/x; rm -rf /' }))).toThrow(/remoteCtlPath/);
  });

  it('refuses an Access config that names no mode, rather than silently stop checking Access', () => {
    const { authMode: _mode, ...noMode } = accessConfig();
    expect(() => loadConfig(writeEnv(noMode), { home: tempDir() })).toThrow(/authMode: cfTeamDomain is set, so say "authMode": "cloudflare-access"/);
  });

  it('rejects unknown config keys (the schema stays strict)', () => {
    expect(() => loadConfig(writeEnv({ ...accessConfig(), sessionSecret: 'belongs-in-secrets' }))).toThrow(/Unrecognized key/);
  });

  // The two hub secrets are generated when missing, so only the invalid one is reported, and CF_ACCESS_AUD is not
  // required outside Access mode.
  it('reports an invalid secret without echoing its value, and never replaces it', () => {
    const env = writeEnv({ authMode: 'local' }, 'SESSION_SECRET=short-secret-value\n');
    const error = captureError(() => loadConfig(env, { home: tempDir() }));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toContain('SESSION_SECRET');
    expect(error.message).not.toContain('short-secret-value');
    expect(readFileSync(env.LUADY_SECRETS ?? '', 'utf8')).toContain('SESSION_SECRET=short-secret-value');
  });

  it('reports unreadable files and invalid JSON', () => {
    const env = writeEnv('{ not json');
    expect(() => loadConfig(env)).toThrow(/is not valid JSON/);
    const missing = { ...env, LUADY_CONFIG: join(tmpdir(), 'luady-missing-dir', 'config.json') };
    expect(() => loadConfig(missing)).toThrow(/cannot read LUADY_CONFIG file/);
  });

  it('never invents a secrets file at a LUADY_SECRETS path that does not exist', () => {
    const env = writeEnv(accessConfig());
    const missing = { ...env, LUADY_SECRETS: join(tmpdir(), 'luady-missing-dir', 'secrets.env') };
    expect(() => loadConfig(missing)).toThrow(/cannot read LUADY_SECRETS file/);
  });
});

describe('loadConfig: the first start', () => {
  it('with LUADY_CONFIG unset, writes a starter ~/.config/luady/config.json and fills every default', () => {
    const { home, env } = freshHome();
    const created: Array<string | null> = [];
    const config = loadConfig(env, { home, root: '/opt/luady', onCreated: (what) => created.push(what.config) });
    const configPath = join(home, '.config', 'luady', 'config.json');
    expect(created).toEqual([configPath]);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(STARTER_CONFIG);
    expect(config).toMatchObject({
      servers: [], webPort: 7410, bindHost: '127.0.0.1', allowRemote: false, publicOrigin: 'http://localhost:7410', rpId: 'localhost',
      allowedHosts: ['localhost:7410'], trustedProxy: null, authMode: 'local', ownerLabel: 'owner', managerFiles: 'own-folder',
      dataDir: join(home, '.local', 'share', 'luady', 'data'), brainDir: join(home, '.local', 'share', 'luady', 'brain'),
      runDir: join(home, '.local', 'share', 'luady', 'run'), webDir: join('/opt/luady', 'packages', 'web', 'dist'),
      fleetKeyPath: join(home, '.local', 'share', 'luady', 'data', 'fleet_ed25519'),
      managerHome: join(home, '.local', 'share', 'luady', 'data', 'manager-home'),
      claudePath: join(home, '.local', 'bin', 'claude'), localCtlPath: join(home, '.luady', 'bin', 'luady-ctl'),
      remoteCtlPath: '~/.luady/bin/luady-ctl', addons: [],
    });
    // Local mode: the Access fields and the owner's phone are absent, not '' (no placeholder stands for "not set").
    expect(config).not.toHaveProperty('cfTeamDomain');
    expect(config).not.toHaveProperty('cfAccessAud');
    expect(config).not.toHaveProperty('ownerEmail');
    expect(config).not.toHaveProperty('ownerPhone');
    expect(config.localHost).toBeUndefined();
  });

  it('honours absolute XDG folders and ignores relative ones', () => {
    const { home } = freshHome();
    const xdg = tempDir();
    const config = loadConfig({ XDG_CONFIG_HOME: join(xdg, 'conf'), XDG_DATA_HOME: 'relative/data' }, { home });
    expect(readFileSync(join(xdg, 'conf', 'luady', 'config.json'), 'utf8')).toContain('"authMode"');
    expect(config.dataDir).toBe(join(home, '.local', 'share', 'luady', 'data'));
  });

  it('never overwrites an existing config file', () => {
    const { home, env } = homeWith({ webPort: 7500 });
    const created: Array<string | null> = [];
    const config = loadConfig(env, { home, onCreated: (what) => created.push(what.config) });
    expect(created).toEqual([null]);
    expect(config.webPort).toBe(7500);
    expect(config.publicOrigin).toBe('http://localhost:7500');
    expect(config.allowedHosts).toEqual(['localhost:7500']);
  });

  // With LUADY_SECRETS unset, secrets.env lives beside the config and is generated once.
  it('generates SESSION_SECRET and HUB_SOCKET_TOKEN once, beside the config, and never again', () => {
    const { home, env } = freshHome();
    const generated: Array<readonly string[]> = [];
    const first = loadConfig(env, { home, onCreated: (what) => generated.push(what.secrets) });
    const secretsPath = join(home, '.config', 'luady', 'secrets.env');
    const text = readFileSync(secretsPath, 'utf8');
    expect(first.sessionSecret).toMatch(HEX64);
    expect(first.hubSocketToken).toMatch(HEX64);
    expect(first.sessionSecret).not.toBe(first.hubSocketToken);
    const second = loadConfig(env, { home, onCreated: (what) => generated.push(what.secrets) });
    expect(generated).toEqual([['SESSION_SECRET', 'HUB_SOCKET_TOKEN'], []]);
    expect(second.sessionSecret).toBe(first.sessionSecret);
    expect(second.hubSocketToken).toBe(first.hubSocketToken);
    expect(readFileSync(secretsPath, 'utf8')).toBe(text);
  });

  it('takes a lock to add a secret, and clears a lock a dead start left behind', () => {
    const { home, env } = freshHome();
    loadConfig(env, { home });
    const secretsPath = join(home, '.config', 'luady', 'secrets.env');
    writeFileSync(secretsPath, `SESSION_SECRET=${SESSION_SECRET}\n`);
    writeFileSync(`${secretsPath}.lock`, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${secretsPath}.lock`, old, old);
    expect(loadConfig(env, { home }).hubSocketToken).toMatch(HEX64);
    expect(existsSync(`${secretsPath}.lock`)).toBe(false);
    // Nothing to add: a lock held by another start does not even matter.
    writeFileSync(`${secretsPath}.lock`, '');
    expect(loadConfig(env, { home }).sessionSecret).toBe(SESSION_SECRET);
  });

  it('adds only the missing secret to an existing file, keeping every line it had', () => {
    const { home, env } = freshHome();
    loadConfig(env, { home });
    const secretsPath = join(home, '.config', 'luady', 'secrets.env');
    writeFileSync(secretsPath, `# mine\nSESSION_SECRET=${SESSION_SECRET}\nIMAP_LABEL=work`);
    const config = loadConfig(env, { home });
    expect(config.sessionSecret).toBe(SESSION_SECRET);
    expect(config.hubSocketToken).toMatch(HEX64);
    const lines = readFileSync(secretsPath, 'utf8').split('\n');
    expect(lines.slice(0, 3)).toEqual(['# mine', `SESSION_SECRET=${SESSION_SECRET}`, 'IMAP_LABEL=work']);
    expect(parseEnvFile(lines.join('\n')).HUB_SOCKET_TOKEN).toBe(config.hubSocketToken);
  });

  it.skipIf(!POSIX)('writes the config and the secrets at 0600 in a 0700 folder', () => {
    const { home, env } = freshHome();
    loadConfig(env, { home });
    expect(modeOf(join(home, '.config', 'luady'))).toBe(0o700);
    expect(modeOf(join(home, '.config', 'luady', 'config.json'))).toBe(0o600);
    expect(modeOf(join(home, '.config', 'luady', 'secrets.env'))).toBe(0o600);
  });
});

describe('loadConfig: the startup refusals of the config file', () => {
  it('a remote install without allowRemote is refused (a public origin, or a non-loopback bind)', () => {
    const origin = homeWith({ publicOrigin: 'https://hub.example' });
    expect(refusalOf(() => loadConfig(origin.env, origin))).toBe('remote-not-allowed');
    const bound = homeWith({ bindHost: '0.0.0.0' });
    expect(refusalOf(() => loadConfig(bound.env, bound))).toBe('remote-not-allowed');
    const ip = homeWith({ publicOrigin: 'http://127.0.0.1:7410' });
    expect(refusalOf(() => loadConfig(ip.env, ip))).toBe('remote-not-allowed');
  });

  it('a remote install whose publicOrigin is not https is refused', () => {
    const plain = homeWith({ bindHost: '192.0.2.10', allowRemote: true });
    expect(refusalOf(() => loadConfig(plain.env, plain))).toBe('remote-not-https');
    const http = homeWith({ publicOrigin: 'http://hub.example', allowRemote: true });
    expect(refusalOf(() => loadConfig(http.env, http))).toBe('remote-not-https');
  });

  it('a remote install with allowRemote and https loads (the passkey is checked once the database is open)', () => {
    const remote = homeWith({ publicOrigin: 'https://hub.example', allowRemote: true });
    expect(loadConfig(remote.env, remote)).toMatchObject({ rpId: 'hub.example', allowedHosts: ['hub.example'], authMode: 'local' });
  });

  it('cloudflare-access mode without cfTeamDomain, ownerEmail or CF_ACCESS_AUD names what is missing', () => {
    const access = homeWith({ authMode: 'cloudflare-access', publicOrigin: 'https://hub.example', allowRemote: true });
    const error = captureError(() => loadConfig(access.env, access));
    expect((error as StartupRefusal).refusal).toBe('access-incomplete');
    expect(error.message).toContain('cfTeamDomain');
    expect(error.message).toContain('ownerEmail');
    expect(error.message).toContain('CF_ACCESS_AUD');
    const partial = homeWith({
      authMode: 'cloudflare-access', publicOrigin: 'https://hub.example', allowRemote: true,
      cfTeamDomain: 'team.cloudflareaccess.com', ownerEmail: 'owner@example.com',
    });
    expect(captureError(() => loadConfig(partial.env, partial)).message).toMatch(/needs CF_ACCESS_AUD \(/);
  });

  it('two hosts sharing an id, or a host with a reserved id, are refused', () => {
    const cedar = { name: 'cedar', host: '192.0.2.13', user: 'dev', port: 22, hostKeyFp: FP };
    expect(refusalOf(() => loadConfig(writeEnv({ ...accessConfig(), servers: [cedar, cedar] })))).toBe('host-ids');
    expect(captureError(() => loadConfig(writeEnv({ ...accessConfig(), servers: [cedar, cedar] }))).message).toMatch(/two hosts share the id "cedar"/);
    for (const name of ['computer', 'setup', 'lot-1x']) {
      const error = captureError(() => loadConfig(writeEnv({ ...accessConfig(), servers: [{ ...cedar, name }] })));
      expect((error as StartupRefusal).refusal).toBe('host-ids');
      expect(error.message).toContain('is reserved');
    }
  });

  it('the refusals that need the database or the files are covered in the remote-access, sealed-probe and modes tests', () => {
    // A marker for the refusals checked elsewhere: remote-no-passkey in remote-access.test.ts, secrets-mismatch in
    // sealed-probe.test.ts and foreign-owner in modes.test.ts, which run them through runHub and the mode checks.
    expect(['remote-no-passkey', 'secrets-mismatch', 'foreign-owner']).toHaveLength(3);
  });
});

describe('parseEnvFile', () => {
  it('parses KEY=VALUE lines literally without shell expansion', () => {
    const text = [
      '# comment',
      '',
      'A=1',
      'B = two words',
      'C="quoted # not a comment"',
      "D='$HOME/x'",
      'E=$HOME/x',
      'F=value # trailing\r',
      '',
    ].join('\n');
    expect(parseEnvFile(text)).toEqual({
      A: '1',
      B: 'two words',
      C: 'quoted # not a comment',
      D: '$HOME/x',
      E: '$HOME/x',
      F: 'value # trailing',
    });
  });

  it('rejects malformed lines without echoing them', () => {
    const error = captureError(() => parseEnvFile('GOOD=1\nthis line holds secret-ish text\n'));
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toBe('secrets file line 2: expected KEY=VALUE');
  });

  it('keeps the last value of a repeated key', () => {
    expect(parseEnvFile('A=1\nA=2\n')).toEqual({ A: '2' });
  });
});
