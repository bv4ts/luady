import { homedir } from 'node:os';
import { posix } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultPaths } from '../../src/config/defaults.js';
import {
  CODEX_SIGN_IN_AGAIN, codexBin, codexEnv, codexSignInMoved, codexUserHome, hubCodexHome, npmEnv, oldCodexSignIns, type RunOptions, type RunResult,
} from '../../src/media/codex.js';
import { createImageGenerator } from '../../src/media/imagegen.js';
import { createFakeOutbound, silentLogger } from '../helpers/fakes.js';

describe('where the image tool keeps Codex', () => {
  it('runs the CLI from .local/bin of the hub user, with a home of its own inside the data folder', () => {
    const home = codexUserHome();
    expect(home).toBe(homedir());
    const dataDir = defaultPaths({}, home).dataDir;
    expect(codexBin(home)).toBe(posix.join(homedir(), '.local/bin/codex'));
    expect(hubCodexHome(dataDir)).toBe(posix.join(dataDir, 'codex'));
    expect(hubCodexHome(dataDir).startsWith(posix.join(home, '.codex'))).toBe(false);
  });

  it('gives a Codex run that home as HOME and CODEX_HOME, so ~/.codex of the user (its settings, MCP servers, sign-in) is never read', () => {
    const env = codexEnv('/home/me', '/home/me/.local/share/luady/data/codex', { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-test', CODEX_HOME: '/home/me/.codex' });
    expect(env).toMatchObject({ HOME: '/home/me/.local/share/luady/data/codex', CODEX_HOME: '/home/me/.local/share/luady/data/codex', PATH: '/home/me/.local/bin:/usr/bin' });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(npmEnv('/home/me', { PATH: '/usr/bin' })).toMatchObject({ HOME: '/home/me', PATH: '/home/me/.local/bin:/usr/bin' });
  });

  it('the tools update runs npm from the PATH, .local/bin of the home first, and installs Codex into that home', async () => {
    const home = '/home/me';
    const run = vi.fn(async (_file: string, _args: readonly string[], _opts: RunOptions): Promise<RunResult> => ({ code: 0, stdout: 'added 1 package\n', stderr: '' }));
    const images = createImageGenerator({
      home, codexDir: '/home/me/.local/share/luady/data/codex', dir: '/home/me/.local/share/luady/brain/inbox/images', inboxDir: '/home/me/.local/share/luady/brain/inbox', log: silentLogger(),
      outbound: createFakeOutbound(), notifyLuady: async () => undefined, fetchServerFile: async () => Buffer.alloc(0), run,
    });
    await expect(images.update()).resolves.toBe('added 1 package');
    const [file, args, opts] = run.mock.calls[0] as [string, string[], RunOptions];
    expect(file).toBe('npm');
    expect(args).toEqual(['install', '-g', '--prefix', '/home/me/.local', '@openai/codex@latest']);
    expect(opts.cwd).toBe(home);
    expect(opts.env.HOME).toBe(home);
    expect(opts.env.PATH?.split(':')[0]).toBe('/home/me/.local/bin');
  });
});

describe('a ChatGPT sign-in made where an older release kept it', () => {
  const dataDir = '/home/me/.local/share/luady/data';
  const only = (...paths: string[]) => (path: string): boolean => paths.includes(path);

  it('asks for a new sign-in while the own Codex home of the hub has none, and never once it has one', () => {
    expect(codexSignInMoved(dataDir, '/home/me', only('/home/me/.codex/auth.json'))).toBe(true);
    expect(codexSignInMoved(dataDir, '/home/me', only('/home/me/.local/share/luady/.codex/auth.json'))).toBe(true);
    expect(codexSignInMoved(dataDir, '/home/me', only('/home/me/.codex/auth.json', `${dataDir}/codex/auth.json`))).toBe(false);
    expect(codexSignInMoved(dataDir, '/home/me', only())).toBe(false);
    expect(CODEX_SIGN_IN_AGAIN).toMatch(/Connect ChatGPT \(pictures\) again/);
    // The old sign-in still holds live tokens: the line says to end it, not only to make a new one.
    expect(CODEX_SIGN_IN_AGAIN).toMatch(/sign the old one out \(codex logout\) or delete its auth\.json/);
    expect(oldCodexSignIns(dataDir, '/home/me', only('/home/me/.codex/auth.json'))).toEqual(['/home/me/.codex/auth.json']);
  });
});
