import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_HOST_ID, SELF_HOST_ID } from '@luady/shared';
import { installLocalKit, installedKitAlias, installedKitVersion, kitInstallArgs, releaseKitVersion, versionOf } from '../../src/fleet/local-kit.js';

const { join } = posix;

/** A release whose `server-kit/install.py` is a script node runs: it echoes its argv the way the installer reports. */
function fakeRelease(body: string): string {
  const root = mkdtempSync(join(tmpdir(), 'luady-kit-'));
  mkdirSync(join(root, 'server-kit', 'luady_kit'), { recursive: true });
  writeFileSync(join(root, 'server-kit', 'install.py'), body);
  writeFileSync(join(root, 'server-kit', 'luady_kit', '__init__.py'), "__version__ = '2.1.0'\n");
  return root;
}

const ECHO = `
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
console.log('copying the kit');
console.log(JSON.stringify({ ok: true, action: 'install', version: '2.1.0', home: at('--home') ?? '/home/dev', host_alias: at('--host-alias'),
  settings: args.includes('--skip-settings') ? null : '/home/dev/.claude/settings.json', projects_root: at('--projects-root'), claude_bin: at('--claude-bin'),
  argv: args }));
`;

describe('the local kit helper', () => {
  it('runs install.py with an argv array (no shell) and returns its JSON summary, every line handed on', async () => {
    const root = fakeRelease(ECHO);
    const lines: string[] = [];
    const summary = await installLocalKit({
      projectsRoot: '/srv/hub/brain', claudeBin: '/srv/hub/bin/claude', home: '/srv/hub/mh', alias: SELF_HOST_ID, skipSettings: true,
      python: process.execPath, root,
    }, (line) => lines.push(line));
    expect(summary).toMatchObject({ ok: true, version: '2.1.0', host_alias: SELF_HOST_ID, home: '/srv/hub/mh', settings: null, projects_root: '/srv/hub/brain', claude_bin: '/srv/hub/bin/claude' });
    expect((summary as unknown as { argv: string[] }).argv).toEqual(kitInstallArgs({
      projectsRoot: '/srv/hub/brain', claudeBin: '/srv/hub/bin/claude', home: '/srv/hub/mh', alias: SELF_HOST_ID, skipSettings: true, root,
    }).slice(1));
    expect(lines[0]).toBe('copying the kit');
  });

  it('installs for the local host by default, and passes hostile-looking values as plain arguments', async () => {
    const summary = await installLocalKit({ projectsRoot: '/home/dev/projects; rm -rf /', claudeBin: '$(id)', python: process.execPath, root: fakeRelease(ECHO) });
    expect(summary).toMatchObject({ host_alias: LOCAL_HOST_ID, projects_root: '/home/dev/projects; rm -rf /', claude_bin: '$(id)' });
  });

  it('reports the installer\'s own error, and a failure to run at all', async () => {
    const failing = fakeRelease('console.error(JSON.stringify({ ok: false, error: "--projects-root must be an absolute path" })); process.exit(1);');
    await expect(installLocalKit({ projectsRoot: 'x', claudeBin: 'y', python: process.execPath, root: failing }))
      .rejects.toThrow('kit install failed: --projects-root must be an absolute path');
    await expect(installLocalKit({ projectsRoot: '/a', claudeBin: '/b', python: join(tmpdir(), 'luady-no-such-python'), root: failing }))
      .rejects.toThrow(/cannot run/);
    await expect(installLocalKit({ projectsRoot: '/a', claudeBin: '/b', python: process.execPath, root: fakeRelease('console.log("no summary")') }))
      .rejects.toThrow('the installer gave no summary');
  });

  it('reads the release and installed kit versions and the installed alias', async () => {
    const root = fakeRelease(ECHO);
    expect(await releaseKitVersion(root)).toBe('2.1.0');
    const home = mkdtempSync(join(tmpdir(), 'luady-home-'));
    expect(await installedKitVersion(home)).toBeNull();
    mkdirSync(join(home, '.luady', 'lib', 'luady_kit'), { recursive: true });
    mkdirSync(join(home, '.luady', 'state'), { recursive: true });
    writeFileSync(join(home, '.luady', 'lib', 'luady_kit', '__init__.py'), "__version__ = '2.0.1'\n");
    writeFileSync(join(home, '.luady', 'state', 'config.json'), JSON.stringify({ host_alias: 'cedar' }));
    expect(await installedKitVersion(home)).toBe('2.0.1');
    expect(await installedKitAlias(home)).toBe('cedar');
  });

  it('reads a version out of a tool\'s version line', () => {
    expect(versionOf('Python 3.12.3')).toEqual([3, 12, 3]);
    expect(versionOf('tmux 3.4')).toEqual([3, 4, 0]);
    expect(versionOf('2.1.330 (Claude Code)')).toEqual([2, 1, 330]);
    expect(versionOf(null)).toBeNull();
  });
});
