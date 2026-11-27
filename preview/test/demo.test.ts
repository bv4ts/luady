import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomsDTO } from '@luady/shared';
import { PREVIEW_OWNER_TZ, PREVIEW_PORT } from '../config.ts';
import { DEMO_USAGE, needsBuild, parseDemoArgs, REPO_ROOT, startDemo, type DemoCli, type DemoDeps } from '../demo.ts';
import type { Preview } from '../main.ts';
import { signedIn, signInPreview } from './sign-in.ts';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function deps(over: Partial<DemoDeps> = {}): DemoDeps & { build: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn> } {
  return { env: {}, repoRoot: REPO_ROOT, build: vi.fn(), open: vi.fn(), onLoginLink: () => undefined, ...over } as DemoDeps & {
    build: ReturnType<typeof vi.fn>; open: ReturnType<typeof vi.fn>;
  };
}

/** The rooms as the website reads them (`GET /api/rooms`, signed in through this run's link). */
async function roomsOf(preview: Preview): Promise<RoomsDTO> {
  const session = await signInPreview(preview);
  const res = await fetch(`${preview.url}/api/rooms`, { headers: signedIn(session) });
  expect(res.status).toBe(200);
  return (await res.json()) as RoomsDTO;
}

const cli = async (over: Partial<DemoCli> = {}): Promise<DemoCli> => ({
  rooms: 'classic', loop: false, clock: undefined, port: await freePort(), keep: undefined, open: false, ...over,
});

describe('npm run demo: the flags', () => {
  it('defaults: the classic office, the loop on, live clock, port 7420, a new folder, no browser', () => {
    expect(parseDemoArgs([])).toEqual({ rooms: 'classic', loop: true, clock: undefined, port: PREVIEW_PORT, keep: undefined, open: false });
  });

  it('reads each flag', () => {
    expect(parseDemoArgs(['--rooms', '24', '--still', '--clock', '2026-11-21T12:00:00Z', '--port', '7500', '--keep', 'demo-data', '--open'])).toEqual({
      rooms: 24, loop: false, clock: new Date('2026-11-21T12:00:00Z'), port: 7500, keep: 'demo-data', open: true,
    });
    expect(parseDemoArgs(['--rooms', '0'])).toMatchObject({ rooms: 0 });
    expect(parseDemoArgs(['--rooms', '1'])).toMatchObject({ rooms: 1 });
    expect(parseDemoArgs(['--rooms', 'mixed', '--loop'])).toMatchObject({ rooms: 'mixed', loop: true });
    expect(parseDemoArgs(['--rooms', 'classic'])).toMatchObject({ rooms: 'classic' });
  });

  it('prints the usage for anything else', () => {
    for (const argv of [
      ['--rooms'], ['--rooms', 'many'], ['--rooms', '-1'], ['--rooms', '1001'], ['--rooms', '2.5'], ['--port', '0'], ['--port', 'x'],
      ['--clock', 'soon'], ['--loop', '--still'], ['--fast'], ['24'], ['--keep', '--open'],
    ]) expect(parseDemoArgs(argv), argv.join(' ')).toBe(DEMO_USAGE);
  });
});

describe('npm run demo: starting', () => {
  let preview: Preview | null = null;
  afterEach(async () => {
    await preview?.stop();
    preview = null;
  });

  it('is refused on a production machine before it builds or opens anything', async () => {
    const d = deps({ env: { NODE_ENV: 'production' } });
    await expect(startDemo(await cli(), d)).rejects.toThrow(/preview-refused/);
    const files = deps({ env: { LUADY_CONFIG: '/etc/luady/config.json' } });
    await expect(startDemo(await cli(), files)).rejects.toThrow(/preview-refused/);
    expect(d.build).not.toHaveBeenCalled();
    expect(files.build).not.toHaveBeenCalled();
  });

  it('needs a build when an output is missing or older than its sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'luady-demo-root-'));
    const file = async (path: string, at: Date): Promise<void> => {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), '');
      await utimes(join(root, path), at, at);
    };
    try {
      expect(needsBuild(root)).toBe(true);
      const old = new Date('2026-01-01T00:00:00Z');
      const fresh = new Date('2026-02-01T00:00:00Z');
      for (const src of ['packages/hub/src/app.ts', 'packages/web/src/main.tsx']) await file(src, old);
      for (const out of ['packages/shared/dist/index.js', 'packages/hub/dist/app.js', 'packages/web/dist/index.html']) await file(out, fresh);
      expect(needsBuild(root)).toBe(false);
      await file('packages/hub/src/app.ts', new Date('2026-03-01T00:00:00Z'));
      expect(needsBuild(root)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('builds when the build is missing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'luady-demo-root-'));
    try {
      const d = deps({ repoRoot: empty });
      preview = await startDemo(await cli({ rooms: 0 }), d);
      expect(d.build).toHaveBeenCalledWith(empty);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("stores this machine's zone without --clock and the fixed zone with it; the tests' own runs keep the fixed zone", async () => {
    const machine = { machineZone: () => 'America/Chicago' };
    preview = await startDemo(await cli({ rooms: 0 }), deps(machine));
    expect(preview.app.services.settings.get().owner_tz).toBe('America/Chicago');
    await preview.stop();
    preview = await startDemo(await cli({ rooms: 0, clock: new Date('2026-11-21T12:00:00Z') }), deps(machine));
    expect(preview.app.services.settings.get().owner_tz).toBe(PREVIEW_OWNER_TZ);
    await preview.stop();
    preview = await startDemo(await cli({ rooms: 0 }), deps());
    expect(preview.app.services.settings.get().owner_tz).toBe(PREVIEW_OWNER_TZ);
  });

  it('--rooms 0 is an empty office; --rooms 1 is Orchard alone', async () => {
    preview = await startDemo(await cli({ rooms: 0 }), deps());
    expect((await roomsOf(preview)).items).toEqual([]);
    await preview.stop();
    preview = await startDemo(await cli({ rooms: 1 }), deps());
    expect((await roomsOf(preview)).items.map((room) => [room.id, room.name])).toEqual([['birch', 'Orchard']]);
  });

  it('--rooms 300 imports 300 rooms at 300 unique positions, with their sessions on the map', async () => {
    preview = await startDemo(await cli({ rooms: 300 }), deps());
    const { items, grid } = await roomsOf(preview);
    expect(items).toHaveLength(300);
    expect(new Set(items.map((room) => room.position)).size).toBe(300);
    expect(grid.slotCount).toBe(300);
    await expect.poll(() => preview?.app.services.sessions.list().filter((s) => s.project?.startsWith('site-') === true).length, { timeout: 15_000 })
      .toBeGreaterThan(100);
  }, 60_000);

  it('--rooms mixed adds two servers with their own links and rooms', async () => {
    preview = await startDemo(await cli({ rooms: 'mixed' }), deps());
    expect((await roomsOf(preview)).items).toHaveLength(12);
    expect(preview.fleet.link('elm')).toBe('online');
    expect(preview.fleet.link('pine')).toBe('online');
    expect(preview.fleet.servers().map((server) => server.name)).toEqual(expect.arrayContaining(['elm', 'pine']));
  });

  it('--loop starts the scenario loop in this process; --still does not; --open opens the sign-in link', async () => {
    preview = await startDemo(await cli({ loop: true, open: true }), deps());
    await expect(preview.run('demo', [])).resolves.toMatch(/already running/);
    await preview.stop();
    const still = deps();
    preview = await startDemo(await cli({ loop: false }), still);
    await expect(preview.run('stop-demo', [])).resolves.toBe('No demo is running.');
    expect(still.open).not.toHaveBeenCalled();
  });

  it('--open hands the browser the current one-time link', async () => {
    const d = deps();
    preview = await startDemo(await cli({ open: true }), d);
    expect(d.open).toHaveBeenCalledWith(preview.loginUrl());
    expect(d.open.mock.calls[0]?.[0]).toMatch(/^http:\/\/localhost:\d+\/__preview\/login\?t=/);
  });
});
