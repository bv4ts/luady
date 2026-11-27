import { describe, expect, it } from 'vitest';
import { createHubPathGuard, hubFolders, normalisePath, type RealPath } from '../../src/security/hub-paths.js';
import { RefusedError } from '../../src/core/errors.js';
import { guardHubFiles } from '../../src/fleet/hub-files.js';
import { createFakeCtl } from '../helpers/fakes.js';

const HOME = '/home/me';
const CONFIG = {
  dataDir: '/home/me/.local/share/luady/data', runDir: '/home/me/.local/share/luady/run', brainDir: '/home/me/.local/share/luady/brain',
  fleetKeyPath: '/home/me/.local/share/luady/data/fleet_ed25519',
};
const FILES = { configPath: '/home/me/.config/luady/config.json', secretsPath: '/home/me/.config/luady/secrets.env' };
/** No symlinks anywhere, unless a test names some. */
const noLinks: RealPath = () => null;

function guard(realpath: RealPath = noLinks, config: typeof CONFIG & { managerHome?: string } = CONFIG, files = FILES) {
  return createHubPathGuard(hubFolders(config, files), { realpath, home: HOME, user: 'me' });
}

const REFUSED = [
  '/home/me/.config/luady/secrets.env',
  '/home/me/.config/luady/config.json',
  '/home/me/.config/luady',
  '/home/me/.local/share/luady/data/hub.db',
  '/home/me/.local/share/luady/data/hub-token',
  '/home/me/.local/share/luady/data/fleet_ed25519',
  '/home/me/.local/share/luady/data/manager-home/.claude/.credentials.json',
  '/home/me/.local/share/luady/run/hub.sock',
  '/home/me/.local/share/luady/brain/.manager/settings.json',
  '/home/me/projects/../.config/luady/secrets.env',
  '/home/me//.local/share/luady//data/hub.db',
  '/home/me/./.local/share/luady/data/',
  '~/.config/luady/secrets.env',
  '~me/.local/share/luady/data/hub.db',
  '/HOME/ME/.Config/Luady/Secrets.env',
  '/home/me/.codex/auth.json',
  '~/.codex/config.toml',
  '/home/me/.local/share/luady/data/codex/auth.json',
];

const OPEN = [
  '/home/me/projects/app/README.md',
  '/home/me/.local/share/luady/brain/inbox/photo.jpg',
  '/home/me/.local/share/luady/database-notes.md',
  '/home/me/.config/luady-other/x',
  '/etc/hosts',
];

describe('the hub\'s own folders on this computer', () => {
  it.for(REFUSED)('refuses %s, saying it belongs to the hub', (path) => {
    expect(guard().refusal(path)).toMatch(/belongs to the hub itself .* with or without a PIN/);
  });

  it.for(OPEN)('leaves %s open', (path) => {
    expect(guard().refusal(path)).toBeNull();
  });

  it('refuses a path that is not absolute once ~ is expanded', () => {
    expect(guard().refusal('projects/x')).toMatch(/not an absolute path/);
    expect(guard().refusal('~other/.config/luady/secrets.env')).toMatch(/not an absolute path/);
  });

  it('follows symlinks: a link into the hub\'s folders is refused, and so is a hub folder that is itself a link', () => {
    const links: RealPath = (path) => ({
      '/home/me/projects/app/link': '/home/me/.local/share/luady/data',
      '/srv/luady-data': '/srv/luady-data',
      '/home/me/.local/share/luady/data': '/srv/luady-data',
    })[path] ?? null;
    expect(guard(links).refusal('/home/me/projects/app/link/hub.db')).not.toBeNull();
    expect(guard(links).refusal('/srv/luady-data/hub.db')).not.toBeNull();
    expect(guard(links).refusal('/home/me/projects/app/other.md')).toBeNull();
  });

  it('refuses a link inside the manager\'s own folder that leads into the hub\'s folders', () => {
    const links: RealPath = (path) => (path === '/home/me/.local/share/luady/brain/inbox/link' ? '/home/me/.local/share/luady/data' : null);
    expect(guard(links).refusal('/home/me/.local/share/luady/brain/inbox/link/hub.db')).not.toBeNull();
    expect(guard(links).refusal('/home/me/.local/share/luady/brain/inbox/photo.jpg')).toBeNull();
  });

  it('uses the configured places: a moved secrets file and manager home, and a brain folder inside the data folder', () => {
    const config = { ...CONFIG, managerHome: '/opt/manager', brainDir: '/home/me/.local/share/luady/data/brain' };
    const files = { configPath: '/etc/luady/config.json', secretsPath: '/run/keys/luady.env' };
    const moved = guard(noLinks, config, files);
    expect(moved.refusal('/run/keys/luady.env')).not.toBeNull();
    expect(moved.refusal('/etc/luady/other.json')).not.toBeNull();
    expect(moved.refusal('/opt/manager/.claude/.credentials.json')).not.toBeNull();
    expect(moved.refusal('/home/me/.local/share/luady/data/brain/inbox/a.png')).toBeNull();
    expect(moved.refusal('/home/me/.local/share/luady/data/hub.db')).not.toBeNull();
    expect(moved.refusal('/home/me/.config/luady/secrets.env')).toBeNull();
  });

  it('refuses an old ChatGPT sign-in beside a moved data folder too, where an older release kept it', () => {
    const moved = guard(noLinks, { ...CONFIG, dataDir: '/srv/luady/data' });
    expect(moved.refusal('/srv/luady/.codex/auth.json')).toMatch(/belongs to the hub itself/);
    expect(moved.refusal('/home/me/.codex/auth.json')).toMatch(/belongs to the hub itself/);
    expect(moved.refusal('/srv/luady/notes.md')).toBeNull();
  });

  it('normalises ~, .., . and repeated slashes', () => {
    expect(normalisePath('~', HOME, 'me')).toBe('/home/me');
    expect(normalisePath('~/a/../b//c/./', HOME, 'me')).toBe('/home/me/b/c');
    expect(normalisePath('~me/x', HOME, 'me')).toBe('/home/me/x');
    expect(normalisePath('/a/b/../../../etc', HOME, 'me')).toBe('/etc');
    expect(normalisePath('relative', HOME, 'me')).toBeNull();
  });
});

describe('the programs the hub runs on this computer', () => {
  const programs = (): ReturnType<typeof createHubPathGuard> => createHubPathGuard(
    hubFolders({ ...CONFIG, localCtlPath: '/home/me/.luady/bin/luady-ctl' }, { ...FILES, installRoot: '/home/me/luady/' }),
    { realpath: noLinks, home: HOME, user: 'me' },
  );

  it.for([
    '/home/me/.luady/bin/luady-ctl', '/home/me/.luady/lib/luady_kit/ops.py', '/home/me/.luady/hooks/hook.py',
    '/home/me/luady/packages/mcp/dist/main.js', '/home/me/luady/packages/hub/dist/main.js', '~/luady/package.json',
  ])('refuses a write to %s, saying it is the hub\'s program', (path) => {
    expect(programs().refusal(path, 'write')).toMatch(/programs the hub runs here .* with or without a PIN/);
  });

  it('still lets them be read, and leaves writes elsewhere open', () => {
    expect(programs().refusal('/home/me/.luady/lib/luady_kit/ops.py', 'read')).toBeNull();
    expect(programs().refusal('/home/me/luady/docs/manager.md')).toBeNull();
    expect(programs().refusal('/home/me/projects/app/run.sh', 'write')).toBeNull();
    expect(programs().refusal('/home/me/luady-notes/x.md', 'write')).toBeNull();
  });
});

describe('the file verbs of this computer', () => {
  it('refuse a write into the programs before the kit is asked, and pass a read of them through', async () => {
    const guarded = createHubPathGuard(
      hubFolders({ ...CONFIG, localCtlPath: '/home/me/.luady/bin/luady-ctl' }, { ...FILES, installRoot: '/home/me/luady' }),
      { realpath: noLinks, home: HOME, user: 'me' },
    );
    const ctl = createFakeCtl();
    const client = guardHubFiles(ctl, guarded);
    await expect(client.fileWrite('/home/me/luady/packages/mcp/dist/main.js', 'x')).rejects.toBeInstanceOf(RefusedError);
    await client.fileRead('/home/me/luady/packages/mcp/dist/main.js', 100);
    expect(ctl.calls.map((call) => call.method)).toEqual(['fileRead']);
  });
});
