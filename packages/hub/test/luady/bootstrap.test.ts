import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF_HOST_ID } from '@luady/shared';
import type { HubConfig } from '../../src/core/contracts.js';
import { managerEnv } from '../../src/fleet/local-env.js';
import { kitInstallArgs, type LocalKitOptions } from '../../src/fleet/local-kit.js';
import { createBootstrap } from '../../src/luady/bootstrap.js';
import { seedBrain } from '../../src/luady/brain-seed.js';
import { buildStartArgs } from '../../src/luady/launch.js';
import { acceptFolderTrust, ownFolderRules, renderMcpConfig, renderSettings } from '../../src/luady/render.js';
import { createExecTmuxRunner } from '../../src/luady/tmux.js';
import { silentLogger } from '../helpers/fakes.js';

const { join } = posix;
const POSIX = process.platform !== 'win32';
const NOW = new Date('2026-11-21T08:00:00.000Z');
const TOKEN = 'c3'.repeat(32);
const modeOf = (path: string): number => statSync(path).mode & 0o777;

const SETTINGS_TEMPLATE = JSON.stringify({
  permissions: { allow: ['mcp__hub__*', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch'], deny: ['Bash', 'WebFetch'] },
  hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'python3 "$HOME/.luady/hooks/luady_hook.py"', timeout: 5 }] }] },
});

/** A release (install root): the brain templates, the kit's version, nothing else. */
function release(files: Readonly<Record<string, string>> = {}, kitVersion = '2.1.0'): string {
  const root = mkdtempSync(join(tmpdir(), 'luady-release-'));
  const all: Record<string, string> = {
    'brain/CLAUDE.md': '# Manual v1\n',
    'brain/README.md': 'developer notes\n',
    'brain/skills/board/SKILL.md': 'board skill v1\n',
    'brain/memory/USER.md': 'seed user\n',
    'brain/memory/journal/.gitkeep': '',
    'brain/workspace/README.md': 'workspace\n',
    'brain/.manager/settings.json': SETTINGS_TEMPLATE,
    'brain/.manager/prompt_gate.py': '# gate\n',
    'brain/.manager/mcp.json': '{"stale": true}',
    'server-kit/luady_kit/__init__.py': `__version__ = '${kitVersion}'\n`,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(join(root, posix.dirname(path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function hubConfig(over: Partial<HubConfig> = {}): HubConfig {
  const base = mkdtempSync(join(tmpdir(), 'luady-hub-'));
  return {
    dataDir: join(base, 'data'), brainDir: join(base, 'brain'), runDir: join(base, 'run'), managerHome: join(base, 'data', 'manager-home'),
    managerFiles: 'own-folder', claudePath: '/srv/hub/bin/claude', hubSocketToken: TOKEN, servers: [],
    ...over,
  } as HubConfig;
}

const read = (path: string): string => readFileSync(path, 'utf8');
afterEach(() => {
  vi.restoreAllMocks();
});

describe('seeding the brain', () => {
  it('copies the release on the first run, without README.md or .manager/, and changes nothing on a second', () => {
    const root = release();
    const target = mkdtempSync(join(tmpdir(), 'luady-brain-'));
    const first = seedBrain(join(root, 'brain'), target);
    expect([...first.created].sort()).toEqual(['CLAUDE.md', 'memory/USER.md', 'memory/journal/.gitkeep', 'skills/board/SKILL.md', 'workspace/README.md']);
    expect(existsSync(join(target, 'README.md'))).toBe(false);
    expect(existsSync(join(target, '.manager', 'settings.json'))).toBe(false);
    const second = seedBrain(join(root, 'brain'), target);
    expect(second).toMatchObject({ created: [], replaced: [], backedUp: [], removed: [] });
  });

  it('never overwrites memory/** or LOCAL.md, even when the release changes', () => {
    const target = mkdtempSync(join(tmpdir(), 'luady-brain-'));
    seedBrain(join(release(), 'brain'), target);
    writeFileSync(join(target, 'memory', 'USER.md'), 'what the manager learned\n');
    writeFileSync(join(target, 'LOCAL.md'), 'the owner\'s own notes\n');
    const next = release({ 'brain/CLAUDE.md': '# Manual v2\n', 'brain/memory/USER.md': 'new seed\n', 'brain/LOCAL.md': 'release local\n' });
    const result = seedBrain(join(next, 'brain'), target);
    expect(read(join(target, 'memory', 'USER.md'))).toBe('what the manager learned\n');
    expect(read(join(target, 'LOCAL.md'))).toBe('the owner\'s own notes\n');
    expect(result.replaced).toEqual(['CLAUDE.md']);
  });

  it('backs up an edited CLAUDE.md before a new release replaces it, and keeps every earlier backup', () => {
    const target = mkdtempSync(join(tmpdir(), 'luady-brain-'));
    seedBrain(join(release(), 'brain'), target);
    writeFileSync(join(target, 'CLAUDE.md'), '# my edits\n');
    // The same release again: a local edit is left alone until the release changes.
    expect(seedBrain(join(release(), 'brain'), target).replaced).toEqual([]);
    expect(read(join(target, 'CLAUDE.md'))).toBe('# my edits\n');
    const v2 = seedBrain(join(release({ 'brain/CLAUDE.md': '# Manual v2\n' }), 'brain'), target);
    expect(v2.backedUp).toEqual([{ path: 'CLAUDE.md', backup: join(target, 'CLAUDE.md.bak') }]);
    expect(read(join(target, 'CLAUDE.md.bak'))).toBe('# my edits\n');
    expect(read(join(target, 'CLAUDE.md'))).toBe('# Manual v2\n');
    writeFileSync(join(target, 'CLAUDE.md'), '# more edits\n');
    seedBrain(join(release({ 'brain/CLAUDE.md': '# Manual v3\n' }), 'brain'), target);
    expect(read(join(target, 'CLAUDE.md.bak'))).toBe('# my edits\n');
    expect(read(join(target, 'CLAUDE.md.bak.2'))).toBe('# more edits\n');
  });

  it('never deletes or writes outside the brain folder, whatever the manifest says', () => {
    const outer = mkdtempSync(join(tmpdir(), 'luady-outer-'));
    const target = join(outer, 'brain');
    seedBrain(join(release(), 'brain'), target);
    writeFileSync(join(outer, 'victim.txt'), 'outside');
    const manifest = JSON.parse(read(join(target, '.manager', 'seed.json'))) as { files: Record<string, string> };
    const victim = createHash('sha256').update('outside').digest('hex');
    const forged = { release: 'older', files: { ...manifest.files, '../victim.txt': victim, '/etc/hostname': victim, 'skills/../../victim.txt': victim } };
    writeFileSync(join(target, '.manager', 'seed.json'), JSON.stringify(forged));
    expect(seedBrain(join(release(), 'brain'), target).removed).toEqual([]);
    expect(read(join(outer, 'victim.txt'))).toBe('outside');
  });

  it.skipIf(!POSIX)('leaves a symbolic link alone: never replaced, never followed into a backup', () => {
    const outer = mkdtempSync(join(tmpdir(), 'luady-outer-'));
    const target = join(outer, 'brain');
    seedBrain(join(release(), 'brain'), target);
    writeFileSync(join(outer, 'secret.txt'), 'outside');
    rmSync(join(target, 'CLAUDE.md'));
    symlinkSync(join(outer, 'secret.txt'), join(target, 'CLAUDE.md'));
    rmSync(join(target, 'memory', 'USER.md'));
    symlinkSync(join(outer, 'missing.txt'), join(target, 'memory', 'USER.md'));
    const result = seedBrain(join(release({ 'brain/CLAUDE.md': 'Manual v2' }), 'brain'), target);
    expect([...result.skipped].sort()).toEqual(['CLAUDE.md', 'memory/USER.md']);
    expect(existsSync(join(target, 'CLAUDE.md.bak'))).toBe(false);
    expect(read(join(outer, 'secret.txt'))).toBe('outside');
    expect(lstatSync(join(target, 'memory', 'USER.md')).isSymbolicLink()).toBe(true);
  });

  it('replaces an unchanged release file without a backup, and removes a release file the new release dropped', () => {
    const target = mkdtempSync(join(tmpdir(), 'luady-brain-'));
    seedBrain(join(release({ 'brain/skills/old/SKILL.md': 'old\n' }), 'brain'), target);
    const result = seedBrain(join(release({ 'brain/skills/board/SKILL.md': 'board skill v2\n' }), 'brain'), target);
    expect(result).toMatchObject({ replaced: ['skills/board/SKILL.md'], backedUp: [], removed: ['skills/old/SKILL.md'] });
    expect(existsSync(join(target, 'skills', 'old', 'SKILL.md'))).toBe(false);
  });
});

describe('the rendered manager config', () => {
  it('mcp.json: the one server `hub`, with absolute paths to node, the MCP entry, the socket and the token file', () => {
    const config = hubConfig();
    const parsed = JSON.parse(renderMcpConfig(config, { root: '/opt/luady', node: '/usr/bin/node' })) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(Object.keys(parsed.mcpServers)).toEqual(['hub']);
    const hub = parsed.mcpServers.hub;
    expect(hub).toEqual({
      type: 'stdio', command: '/usr/bin/node', args: ['/opt/luady/packages/mcp/dist/main.js'],
      env: { LUADY_HUB_SOCKET: join(config.runDir, 'hub.sock'), LUADY_HUB_TOKEN_FILE: join(config.dataDir, 'hub-token') },
    });
    for (const path of [hub?.command ?? '', ...(hub?.args ?? []), ...Object.values(hub?.env ?? {})]) expect(path.startsWith('/') || /^[A-Za-z]:/.test(path), path).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain(TOKEN);
  });

  it('settings.json with own-folder: the file tools only under brainDir; the hooks and every other rule as shipped', () => {
    const settings = JSON.parse(renderSettings(hubConfig({ brainDir: '/srv/hub/brain' }), SETTINGS_TEMPLATE)) as { permissions: { allow: string[]; deny: string[] }; hooks: unknown };
    expect(settings.permissions.allow).toEqual(['mcp__hub__*', 'WebSearch', 'Read(//srv/hub/brain/**)', 'Edit(//srv/hub/brain/**)']);
    // Deny rules come before allow rules: the manager can never rewrite its own hook, settings or MCP config.
    expect(settings.permissions.deny).toEqual([
      'Bash', 'WebFetch', 'Edit(//srv/hub/brain/.manager/**)', 'Edit(//srv/hub/brain/.claude/**)', 'Edit(//srv/hub/brain/.mcp.json)',
    ]);
    expect(settings.hooks).toEqual(JSON.parse(SETTINGS_TEMPLATE).hooks);
    const any = JSON.parse(renderSettings(hubConfig({ managerFiles: 'any', brainDir: '/srv/hub/brain' }), SETTINGS_TEMPLATE)) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(any.permissions.allow).toContain('Read');
    expect(any.permissions.deny).toEqual(expect.arrayContaining([
      'Edit(//srv/hub/brain/.manager/**)', 'Edit(//srv/hub/brain/.claude/**)', 'Edit(//srv/hub/brain/.mcp.json)',
    ]));
  });

  // The folder rule needs a POSIX brainDir; Windows temp paths are not (the hub runs on Linux and WSL2).
  it.skipIf(!POSIX)('writes the rendered files again before every launch, so a changed hook never reaches a new manager', async () => {
    const config = { ...hubConfig(), brainDir: join(mkdtempSync(join(tmpdir(), 'luady-launch-')), 'brain') };
    const bootstrap = createBootstrap({ config, log: silentLogger(), now: () => NOW, installKit: null, root: release() });
    await bootstrap.run();
    const gate = join(config.brainDir, '.manager', 'prompt_gate.py');
    writeFileSync(gate, 'import os; os.system("anything")');
    writeFileSync(join(config.dataDir, 'hub-token'), 'not-the-token');
    await bootstrap.prepareLaunch();
    expect(read(gate)).toBe(read(join(release(), 'brain', '.manager', 'prompt_gate.py')));
    expect(read(join(config.dataDir, 'hub-token')).trim()).toBe(TOKEN);
  });

  it('refuses a brainDir the folder rule cannot hold safely, rather than widen the rule', () => {
    expect(ownFolderRules('/srv/hub/brain/')).toEqual(['Read(//srv/hub/brain/**)', 'Edit(//srv/hub/brain/**)']);
    for (const bad of ['/srv/my brain', '/srv/b*', '/srv/(x)', 'relative/brain']) expect(() => ownFolderRules(bad), bad).toThrow(/brainDir/);
  });

  it('pre-accepts the folder trust for brainDir in the manager\'s .claude.json, keeping every other key', () => {
    const home = mkdtempSync(join(tmpdir(), 'luady-home-'));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ theme: 'dark', projects: { '/elsewhere': { allowedTools: [] } } }));
    expect(acceptFolderTrust(home, '/srv/hub/brain')).toBe(true);
    expect(JSON.parse(read(join(home, '.claude.json')))).toEqual({
      theme: 'dark', projects: { '/elsewhere': { allowedTools: [] }, '/srv/hub/brain': { hasTrustDialogAccepted: true } },
    });
    expect(acceptFolderTrust(home, '/srv/hub/brain')).toBe(false);
  });
});

describe('the bootstrap', () => {
  function bootstrapWith(config: HubConfig, root: string) {
    const installs: LocalKitOptions[] = [];
    const installKit = vi.fn(async (options: LocalKitOptions) => {
      installs.push(options);
      const home = options.home ?? '';
      mkdirSync(join(home, '.luady', 'lib', 'luady_kit'), { recursive: true });
      mkdirSync(join(home, '.luady', 'state'), { recursive: true });
      writeFileSync(join(home, '.luady', 'lib', 'luady_kit', '__init__.py'), read(join(root, 'server-kit', 'luady_kit', '__init__.py')));
      writeFileSync(join(home, '.luady', 'state', 'config.json'), JSON.stringify({ host_alias: options.alias }));
      return { version: '2.1.0' };
    });
    return { bootstrap: createBootstrap({ config, log: silentLogger(), now: () => NOW, installKit, root }), installKit, installs };
  }

  // The folder rule needs a POSIX brainDir; Windows temp paths are not (the hub runs on Linux and WSL2).
  it.skipIf(!POSIX)('runs every step: folders, brain, the rendered files, the token file, the kit and the folder trust', async () => {
    const root = release();
    const config = hubConfig();
    const { bootstrap, installs } = bootstrapWith(config, root);
    const report = await bootstrap.run();
    expect(report.state).toBe('done');
    expect(report.steps.map((step) => [step.id, step.state])).toEqual([
      ['folders', 'done'], ['brain', 'done'], ['render', 'done'], ['token', 'done'], ['kit', 'done'], ['trust', 'done'],
    ]);
    expect(read(join(config.brainDir, 'CLAUDE.md'))).toBe('# Manual v1\n');
    expect(JSON.parse(read(join(config.brainDir, '.manager', 'mcp.json'))).mcpServers.hub.command).toBe(process.execPath);
    expect(read(join(config.dataDir, 'hub-token')).trim()).toBe(TOKEN);
    expect(report.kit).toEqual({ path: join(config.managerHome ?? '', '.luady', 'bin', 'luady-ctl'), version: '2.1.0', alias: SELF_HOST_ID });
    expect(installs).toEqual([expect.objectContaining({
      home: config.managerHome, alias: SELF_HOST_ID, skipSettings: true, claudeBin: config.claudePath, projectsRoot: config.brainDir,
    })]);
    expect(installs[0]?.env).toMatchObject({ HOME: config.managerHome, TMUX_TMPDIR: join(config.managerHome ?? '', 'tmux') });
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });

  // The folder rule needs a POSIX brainDir; Windows temp paths are not (the hub runs on Linux and WSL2).
  it.skipIf(!POSIX)('installs the kit once per kit version: a second run does not, a new release does', async () => {
    const config = hubConfig();
    const { bootstrap, installKit } = bootstrapWith(config, release());
    await bootstrap.run();
    await bootstrap.run();
    expect(installKit).toHaveBeenCalledTimes(1);
    const upgraded = bootstrapWith(config, release({}, '2.2.0'));
    await upgraded.bootstrap.run();
    expect(upgraded.installKit).toHaveBeenCalledTimes(1);
  });

  it('stops at the first failing step and reports it in plain words', async () => {
    // A brainDir with a space cannot be written into the folder rule: the render step fails, the rest never runs.
    const config = hubConfig();
    const { bootstrap } = bootstrapWith({ ...config, brainDir: join(mkdtempSync(join(tmpdir(), 'luady-x-')), 'my brain') }, release());
    const report = await bootstrap.run();
    expect(report.state).toBe('failed');
    expect(report.steps.find((step) => step.id === 'render')).toMatchObject({ state: 'failed', detail: expect.stringMatching(/brainDir must be/) });
    expect(report.steps.find((step) => step.id === 'kit')?.state).toBe('pending');
  });

  it.skipIf(!POSIX)('the token file and the rendered files are 0600, the folders 0700', async () => {
    const config = hubConfig();
    await bootstrapWith(config, release()).bootstrap.run();
    expect(modeOf(join(config.dataDir, 'hub-token'))).toBe(0o600);
    expect(modeOf(join(config.brainDir, '.manager', 'mcp.json'))).toBe(0o600);
    expect(modeOf(config.managerHome ?? '')).toBe(0o700);
    expect(modeOf(join(config.managerHome ?? '', 'tmux'))).toBe(0o700);
  });
});

describe('the manager\'s own tmux server and kit', () => {
  it('the kit installer gets the home, the self host alias and --skip-settings', () => {
    expect(kitInstallArgs({ projectsRoot: '/srv/hub/brain', claudeBin: '/srv/hub/bin/claude', home: '/srv/hub/mh', alias: SELF_HOST_ID, skipSettings: true, root: '/opt/luady' }))
      .toEqual(['/opt/luady/server-kit/install.py', '--host-alias', SELF_HOST_ID, '--projects-root', '/srv/hub/brain', '--claude-bin', '/srv/hub/bin/claude',
        '--home', '/srv/hub/mh', '--skip-settings']);
  });

  it('the tmux runner\'s env carries HOME and TMUX_TMPDIR, and drops what would point at another server', async () => {
    const env = managerEnv('/srv/hub/mh', { PATH: '/usr/bin', HOME: '/home/dev', TMUX: '/tmp/tmux-1000/default,1,0', TMUX_PANE: '%1', CLAUDE_CONFIG_DIR: '/home/dev/.claude' });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/srv/hub/mh', TMUX_TMPDIR: '/srv/hub/mh/tmux' });
    // The runner hands that environment to every call: node stands in for tmux and prints what it got.
    const runner = createExecTmuxRunner(process.execPath, managerEnv('/srv/hub/mh', { ...process.env, TMUX: '/tmp/tmux-1000/default,1,0' }));
    const result = await runner.run(['-e', 'console.log(JSON.stringify([process.env.HOME, process.env.TMUX_TMPDIR, process.env.TMUX ?? null]))']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['/srv/hub/mh', '/srv/hub/mh/tmux', null]);
  });

  it('new-session carries -e HOME=<managerHome>', () => {
    const args = buildStartArgs({ brainDir: '/srv/hub/brain', claudePath: '/srv/hub/bin/claude', managerHome: '/srv/hub/mh' }, 'opus', 'high', null);
    expect(args.slice(0, 6)).toEqual(['new-session', '-d', '-e', 'HOME=/srv/hub/mh', '-s', 'manager']);
  });
});
