import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { z } from 'zod';
import { LOCAL_HOST_ID } from '@luady/shared';
import { installRoot } from '../config/defaults.js';
import { createLineBuffer } from '../ingest/line-buffer.js';

/** The kit installs within this, or the job fails (a hung python is killed). */
export const KIT_INSTALL_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 15_000;
const LINE_MAX = 500;
const ERROR_MAX = 300;
/** The oldest Python the kit runs on (the installer refuses older ones itself too). */
export const MIN_PYTHON: readonly [number, number] = [3, 10];
/** `new-session -e` needs tmux 3.2. */
export const MIN_TMUX: readonly [number, number] = [3, 2];

/** The installer's JSON summary (server-kit install.py), the fields the hub reads. */
export const KitSummarySchema = z.object({
  ok: z.literal(true),
  action: z.literal('install'),
  version: z.string().min(1).max(32),
  home: z.string(),
  host_alias: z.string().min(1).max(32),
  settings: z.string().nullable(),
  projects_root: z.string().nullable().optional(),
  claude_bin: z.string().nullable().optional(),
}).loose();
export type KitSummary = z.infer<typeof KitSummarySchema>;

export interface LocalKitOptions {
  /** Where the kit lets sessions start on this machine. */
  readonly projectsRoot: string;
  /** This machine's Claude Code. */
  readonly claudeBin: string;
  /** Install into this home instead of the hub user's (the manager's own home). */
  readonly home?: string;
  /** The kit's name for this machine (`--host-alias`); the local host's id when absent. */
  readonly alias?: string;
  /** Code only: leave `~/.claude/settings.json` alone (the manager gets its hooks from `--settings`). */
  readonly skipSettings?: boolean;
  /** The environment the installer runs in (the manager's HOME for the self host). */
  readonly env?: NodeJS.ProcessEnv;
  readonly python?: string;
  /** The install root holding `server-kit/` (tests pass their own). */
  readonly root?: string;
  readonly timeoutMs?: number;
}

/** The installer's argv (no shell ever parses it): `install.py --host-alias … --projects-root … --claude-bin …`. */
export function kitInstallArgs(options: LocalKitOptions & { readonly alias: string }): string[] {
  const root = options.root ?? installRoot();
  return [
    posix.join(root, 'server-kit', 'install.py'),
    '--host-alias', options.alias,
    '--projects-root', options.projectsRoot,
    '--claude-bin', options.claudeBin,
    ...(options.home === undefined ? [] : ['--home', options.home]),
    ...(options.skipSettings === true ? ['--skip-settings'] : []),
  ];
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The installer's own error (`{"ok": false, "error": …}` on stderr), or the last stderr line. */
function installError(code: number | null, stderr: string): Error {
  const last = stderr.trim().split('\n').at(-1) ?? '';
  try {
    const parsed = JSON.parse(last) as { error?: unknown };
    if (typeof parsed.error === 'string') return new Error(`kit install failed: ${clip(parsed.error, ERROR_MAX)}`);
  } catch {
    // not JSON: fall through
  }
  return new Error(`kit install failed (exit ${code ?? 'signal'})${last === '' ? '' : `: ${clip(last, ERROR_MAX)}`}`);
}

/**
 * Installs the kit on this machine: `python3 <install>/server-kit/install.py` with an argv array and no
 * shell, each output line handed to `onLine` (at most 500 characters), and the installer's JSON summary returned.
 * Used for "this computer" (hosts/kit-job.ts) and for the manager's own home (the bootstrap, `alias` = the self host).
 */
export function installLocalKit(options: LocalKitOptions, onLine: (line: string) => void = () => undefined): Promise<KitSummary> {
  const alias = options.alias ?? LOCAL_HOST_ID;
  const args = kitInstallArgs({ ...options, alias });
  return new Promise((resolve, reject) => {
    const child = spawn(options.python ?? 'python3', args, {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(options.env === undefined ? {} : { env: options.env }),
    });
    const out = createLineBuffer();
    const err = createLineBuffer();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? KIT_INSTALL_TIMEOUT_MS);
    const take = (lines: readonly string[], into: string[]): void => {
      for (const line of lines) {
        into.push(line);
        onLine(clip(line, LINE_MAX));
      }
    };
    child.stdout.on('data', (chunk: Buffer) => take(out.push(chunk), stdout));
    child.stderr.on('data', (chunk: Buffer) => take(err.push(chunk), stderr));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`cannot run ${options.python ?? 'python3'}: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // A last line without its newline still counts.
      take(out.pending().trim() === '' ? [] : [out.pending()], stdout);
      take(err.pending().trim() === '' ? [] : [err.pending()], stderr);
      if (code !== 0) {
        reject(installError(code, stderr.join('\n')));
        return;
      }
      const parsed = KitSummarySchema.safeParse(parseLast(stdout));
      if (parsed.success) resolve(parsed.data);
      else reject(new Error('kit install failed: the installer gave no summary'));
    });
  });
}

function parseLast(lines: readonly string[]): unknown {
  const last = [...lines].reverse().find((line) => line.trim() !== '');
  if (last === undefined) return null;
  try {
    return JSON.parse(last) as unknown;
  } catch {
    return null;
  }
}

/** What this machine has for the kit: versions found, and what is missing, in plain words. */
export interface Preflight {
  readonly python: string | null;
  readonly tmux: string | null;
  readonly claude: string | null;
  readonly missing: readonly string[];
}

export interface PreflightOptions {
  readonly claudeBin: string;
  readonly python?: string;
  readonly tmux?: string;
  readonly env?: NodeJS.ProcessEnv;
}

function probe(file: string, args: readonly string[], env: NodeJS.ProcessEnv | undefined): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: PROBE_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', ...(env === undefined ? {} : { env }) },
      (error, stdout, stderr) => resolve(error === null ? `${stdout}${stderr}`.trim() : null));
  });
}

/** The first `major.minor[.patch]` in a version line, as numbers. */
export function versionOf(text: string | null): number[] | null {
  const match = text === null ? null : /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
}

function atLeast(found: number[] | null, min: readonly [number, number]): boolean {
  if (found === null) return false;
  const [major = 0, minor = 0] = found;
  return major > min[0] || (major === min[0] && minor >= min[1]);
}

/** Checks Python 3.10+, tmux 3.2+ and Claude Code at its path, without changing anything. */
export async function preflight(options: PreflightOptions): Promise<Preflight> {
  const [python, tmux, claude] = await Promise.all([
    probe(options.python ?? 'python3', ['--version'], options.env),
    probe(options.tmux ?? 'tmux', ['-V'], options.env),
    probe(options.claudeBin, ['--version'], options.env),
  ]);
  const missing = [
    atLeast(versionOf(python), MIN_PYTHON) ? null : `Python ${MIN_PYTHON.join('.')} or later (python3)`,
    atLeast(versionOf(tmux), MIN_TMUX) ? null : `tmux ${MIN_TMUX.join('.')} or later`,
    claude === null ? `Claude Code at ${options.claudeBin}` : null,
  ].filter((item): item is string => item !== null);
  return { python: versionOf(python)?.join('.') ?? null, tmux: versionOf(tmux)?.slice(0, 2).join('.') ?? null, claude: versionOf(claude)?.join('.') ?? null, missing };
}

/** The kit version this release ships (`server-kit/luady_kit/__init__.py`). */
export async function releaseKitVersion(root: string = installRoot()): Promise<string | null> {
  return kitVersionIn(posix.join(root, 'server-kit', 'luady_kit', '__init__.py'));
}

/** The kit version installed under a home (`~/.luady/lib/luady_kit/__init__.py`), or null when none is. */
export async function installedKitVersion(home: string): Promise<string | null> {
  return kitVersionIn(posix.join(home, '.luady', 'lib', 'luady_kit', '__init__.py'));
}

/** The alias the kit under a home was installed for (`~/.luady/state/config.json` host_alias). */
export async function installedKitAlias(home: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(posix.join(home, '.luady', 'state', 'config.json'), 'utf8')) as { host_alias?: unknown };
    return typeof parsed.host_alias === 'string' ? parsed.host_alias : null;
  } catch {
    return null;
  }
}

async function kitVersionIn(file: string): Promise<string | null> {
  try {
    const match = /__version__\s*=\s*['"]([0-9A-Za-z.+-]{1,32})['"]/.exec(await readFile(file, 'utf8'));
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
