import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scriptText } from '../../src/fleet/fixed-scripts.js';
import { manualKeyRemoval } from '../../src/hosts/key-line.js';

/**
 * The key-remove script run for real under `sh`, in a throw-away HOME. A fake `grep`
 * placed first on PATH makes the filter step fail; the original authorized_keys must then stay exactly as it was.
 */
const BLOB = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 5)]).toString('base64');
const HUB_LINE = `no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 ${BLOB} luady-fleet`;
const OTHER = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOTHEROTHEROTHEROTHEROTHEROTHEROTHEROTHE someone-else';

function shell(): string | null {
  const found = spawnSync('sh', ['-c', 'command -v grep'], { encoding: 'utf8' });
  return found.status === 0 ? found.stdout.trim() : null;
}
const realGrep = shell();

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly home: string;
}

/** A HOME with `~/.ssh/authorized_keys` holding `content`, and optionally a `grep` that fails on the filter step. */
function home(content: string, fakeGrep?: string): { home: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'luady-key-remove-'));
  mkdirSync(join(dir, '.ssh'));
  writeFileSync(join(dir, '.ssh', 'authorized_keys'), content);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir };
  if (fakeGrep !== undefined) {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'grep'), `#!/bin/sh\ncase "$1" in -vF) ${fakeGrep} ;; esac\nexec '${realGrep ?? 'grep'}' "$@"\n`);
    chmodSync(join(bin, 'grep'), 0o755);
    env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
  }
  return { home: dir, env };
}

function runScript(content: string, fakeGrep?: string, blob: string = BLOB): Run {
  const made = home(content, fakeGrep);
  const out = spawnSync('sh', ['-c', scriptText('key-remove'), 'luady', blob], { env: made.env, encoding: 'utf8' });
  return { code: out.status, stdout: out.stdout.trim(), stderr: out.stderr.trim(), home: made.home };
}

const keys = (run: Run): string => readFileSync(join(run.home, '.ssh', 'authorized_keys'), 'utf8');
const leftovers = (run: Run): string[] => readdirSync(join(run.home, '.ssh')).filter((name) => name !== 'authorized_keys');

describe.runIf(realGrep !== null)('the key-remove script under sh', () => {
  it('removes only the hub\'s lines and keeps the rest', () => {
    const run = runScript(`${OTHER}\n\n${HUB_LINE}\n`);
    expect(run).toMatchObject({ code: 0, stdout: 'removed' });
    expect(keys(run)).toBe(`${OTHER}\n\n`);
    expect(leftovers(run)).toEqual([]);
  });

  it('a filter step that fails (grep ends with 2 after a partial write) leaves authorized_keys exactly as it was', () => {
    const original = `${OTHER}\n${HUB_LINE}\n`;
    const run = runScript(original, "printf 'partial\\n'; exit 2");
    expect(run.code).toBe(74);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('left as it was');
    expect(keys(run)).toBe(original);
    expect(leftovers(run)).toEqual([]);
  });

  it('an empty filtered file while other lines exist is refused too', () => {
    const original = `${OTHER}\n${HUB_LINE}\n`;
    const run = runScript(original, 'exit 1');
    expect(run.code).toBe(75);
    expect(keys(run)).toBe(original);
    expect(leftovers(run)).toEqual([]);
  });

  it('when the hub\'s line is the only one, the file ends empty and nothing stray is left', () => {
    const run = runScript(`${HUB_LINE}\n`);
    expect(run).toMatchObject({ code: 0, stdout: 'removed' });
    expect(keys(run)).toBe('');
    expect(leftovers(run)).toEqual([]);
  });

  it('a file without the hub\'s line is left alone; a foreign blob is refused before anything is read', () => {
    const absent = runScript(`${OTHER}\n`);
    expect(absent).toMatchObject({ code: 0, stdout: 'absent' });
    expect(keys(absent)).toBe(`${OTHER}\n`);
    const foreign = runScript(`${OTHER}\n`, undefined, 'AAAAB3NzaC1yc2E');
    expect(foreign.code).toBe(64);
    expect(keys(foreign)).toBe(`${OTHER}\n`);
  });

  it('the hand-run command behaves the same when pasted into a shell', () => {
    for (const content of [`${HUB_LINE}\n`, `${OTHER}\n${HUB_LINE}\n`]) {
      const made = home(content);
      const out = spawnSync('sh', ['-c', manualKeyRemoval({ blob: BLOB })], { env: made.env, encoding: 'utf8' });
      expect(out.status).toBe(0);
      expect(out.stdout.trim()).toBe('removed');
      expect(readFileSync(join(made.home, '.ssh', 'authorized_keys'), 'utf8')).not.toContain(BLOB);
      expect(existsSync(join(made.home, '.ssh', 'authorized_keys.new'))).toBe(false);
      expect(readdirSync(join(made.home, '.ssh'))).toEqual(['authorized_keys']);
    }
    const failing = home(`${OTHER}\n${HUB_LINE}\n`, 'exit 2');
    const out = spawnSync('sh', ['-c', manualKeyRemoval({ blob: BLOB })], { env: failing.env, encoding: 'utf8' });
    expect(out.status).toBe(74);
    expect(readFileSync(join(failing.home, '.ssh', 'authorized_keys'), 'utf8')).toBe(`${OTHER}\n${HUB_LINE}\n`);
  });
});
