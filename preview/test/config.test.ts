import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertWebConfig } from '../../packages/hub/dist/web/server.js';
import { PREVIEW_OWNER_TZ, demoOwnerZone, machineZone, previewConfig, previewOrigins } from '../config.ts';
import { assertBuilt, assertPortFree, assertPreviewAllowed, staleBuildWarning } from '../guards.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'luady-preview-test-'));
  temps.push(dir);
  return dir;
}

function writeAt(path: string, seconds: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '// test\n');
  utimesSync(path, seconds, seconds);
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('assertPreviewAllowed', () => {
  it('allows an empty environment', () => {
    expect(() => assertPreviewAllowed({})).not.toThrow();
  });

  it.each([
    [{ NODE_ENV: 'production' }],
    [{ LUADY_CONFIG: '/x' }],
    [{ LUADY_SECRETS: '/x' }],
  ])('refuses %o', (env) => {
    expect(() => assertPreviewAllowed(env)).toThrow(/preview-refused/);
  });
});

describe('previewOrigins', () => {
  it('pairs the browser origin with the https origin the hub expects', () => {
    expect(previewOrigins(7420)).toEqual({ http: 'http://localhost:7420', https: 'https://localhost:7420' });
  });
});

describe('previewConfig', () => {
  const make = () => previewConfig({ dir: tempDir(), port: 7420, webDir: join(REPO_ROOT, 'packages', 'web', 'dist') });

  it('passes the hub web config check', () => {
    expect(() => assertWebConfig(make())).not.toThrow();
  });

  it('makes new 64-hex secrets on every call', () => {
    const a = make();
    const b = make();
    expect(a.sessionSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(b.sessionSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sessionSecret).not.toBe(b.sessionSecret);
    expect(a.hubSocketToken).not.toBe(b.hubSocketToken);
  });

  it('runs as a new install does: local sign-in on loopback, no Access, no add-on', () => {
    const config = make();
    expect(config).toMatchObject({ authMode: 'local', bindHost: '127.0.0.1', allowRemote: false, addons: [] });
    // No Access e-mail and no Access fields at all: absent, not '' (no placeholder stands for "not set").
    for (const key of ['ownerEmail', 'cfTeamDomain', 'cfAccessAud']) expect(config).not.toHaveProperty(key);
  });

  it('seeds the classic four rooms through config.rooms', () => {
    const rooms = make().rooms ?? [];
    expect(rooms.map((r) => `${r.position}:${r.id}:${r.name}:${r.host}:${r.kind}:${r.species}`)).toEqual([
      '0:birch:Orchard:birch:server:bun', '1:ash:Harbor:ash:server:bot', '2:cedar:Meadow:cedar:server:shield',
      '3:local:Private Projects:local:server:ghost',
    ]);
    expect(rooms.map((r) => `${r.colour} ${r.accent}`)).toEqual(['#d6336c #74b816', '#f76707 #37b24d', '#12b886 #c3fae8', '#7c5cff #ffd84d']);
  });

  it('lists the four servers on reserved preview hosts and no real identifiers', () => {
    const config = make();
    expect(config.servers.map((s) => s.name)).toEqual(['cedar', 'birch', 'ash', 'local']);
    expect(config.servers.every((s) => s.host === `${s.name}.preview.invalid`)).toBe(true);
    expect(config).not.toHaveProperty('ownerPhone');
    expect(config.publicOrigin).toBe('https://localhost:7420');
    // No phone, no Google, no extra mailbox: each is null, as loadConfig sets it when secrets.env names none.
    expect([config.twilio, config.google, config.imap]).toEqual([null, null, null]);
  });
});

describe('assertBuilt', () => {
  it('names the build command when the build is missing', () => {
    expect(() => assertBuilt(tempDir())).toThrow(/preview-not-built/);
    expect(() => assertBuilt(tempDir())).toThrow(/npm run build/);
  });

  it('accepts the real repository after npm run build', () => {
    expect(() => assertBuilt(REPO_ROOT)).not.toThrow();
  });
});

describe('assertPortFree', () => {
  function occupy(host: string): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise((resolve) => {
      const server = createServer().listen(0, host, () => {
        const port = (server.address() as AddressInfo).port;
        resolve({ port, close: () => new Promise<void>((done) => server.close(() => done())) });
      });
    });
  }

  it('passes on a free port', async () => {
    const { port, close } = await occupy('127.0.0.1');
    await close();
    await expect(assertPortFree(port)).resolves.toBeUndefined();
  });

  it('names the port and --port when only the IPv4 loopback is taken', async () => {
    const { port, close } = await occupy('127.0.0.1');
    try {
      await expect(assertPortFree(port)).rejects.toThrow(`Port ${port} is in use. Try: npm run preview -- --port ${port + 1}`);
    } finally {
      await close();
    }
  });
});

describe('staleBuildWarning', () => {
  it('warns when a hub source is newer than the build', () => {
    const root = tempDir();
    writeAt(join(root, 'packages', 'hub', 'dist', 'app.js'), 1_000_000);
    writeAt(join(root, 'packages', 'hub', 'src', 'x.ts'), 2_000_000);
    expect(staleBuildWarning(root)).toContain('npm run build');
  });

  it('is null when the build is newer than every source', () => {
    const root = tempDir();
    writeAt(join(root, 'packages', 'hub', 'src', 'x.ts'), 1_000_000);
    writeAt(join(root, 'packages', 'hub', 'dist', 'app.js'), 2_000_000);
    expect(staleBuildWarning(root)).toBeNull();
  });

  it('is null after an incremental build that left an unchanged output old (tsc -b writes only what changed)', () => {
    const root = tempDir();
    writeAt(join(root, 'packages', 'hub', 'dist', 'app.js'), 1_000_000);
    writeAt(join(root, 'packages', 'hub', 'src', 'doctor', 'x.ts'), 2_000_000);
    writeAt(join(root, 'packages', 'hub', 'dist', 'doctor', 'x.js'), 3_000_000);
    expect(staleBuildWarning(root)).toBeNull();
  });

  it('does not count a typecheck\'s build info as a build', () => {
    const root = tempDir();
    writeAt(join(root, 'packages', 'hub', 'dist', 'app.js'), 1_000_000);
    writeAt(join(root, 'packages', 'hub', 'src', 'x.ts'), 2_000_000);
    writeAt(join(root, 'packages', 'hub', 'dist', 'typecheck.tsbuildinfo'), 3_000_000);
    expect(staleBuildWarning(root)).toContain('npm run build');
  });
});

describe('the hub itself', () => {
  it('contains no preview-only code', () => {
    const src = join(REPO_ROOT, 'packages', 'hub', 'src');
    const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((name) => readFileSync(join(src, name), 'utf8').includes('__preview'));
    expect(offenders).toEqual([]);
  });
});

describe('the owner zone of npm run demo and npm run preview', () => {
  it("is this machine's own without --clock, and the fixed zone with it, so a fixed clock shows the same office everywhere", () => {
    expect(demoOwnerZone(undefined, () => 'America/Chicago')).toBe('America/Chicago');
    expect(demoOwnerZone(new Date('2026-11-21T12:00:00Z'), () => 'America/Chicago')).toBe(PREVIEW_OWNER_TZ);
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: machineZone() })).not.toThrow();
  });
});
