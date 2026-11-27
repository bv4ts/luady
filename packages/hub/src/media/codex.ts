import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';

/** Never handed to codex: it must only ever bill the owner's ChatGPT plan, never an API account. */
const API_ENV = new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']);
const KILL_GRACE_MS = 10_000;

/** The Codex CLI the nightly tools update installs: in the hub user's own `~/.local/bin`. */
export const codexBin = (home: string): string => posix.join(home, '.local/bin/codex');

/**
 * The hub's own Codex home, inside its data folder (which the path guard covers): the ChatGPT sign-in for pictures
 * (auth.json) and Codex's settings live here, apart from the user's own `~/.codex`, whose settings, MCP servers and
 * sign-in the image job never loads. Codex reads its home from CODEX_HOME (and refuses one that does not exist).
 */
export const hubCodexHome = (dataDir: string): string => posix.join(dataDir, 'codex');

/** The home of the user the hub runs as: where `~/.local/bin/codex` and npm's install go. */
export function codexUserHome(): string {
  return homedir();
}

/** Makes the hub's Codex home (0700) when it is missing; Codex will not start with a CODEX_HOME that does not exist. */
export function ensureCodexHome(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Where an older release kept the hub's Codex sign-in: the user's own `~/.codex`, or the folder beside the data folder. */
export function oldCodexHomes(dataDir: string, userHome: string): string[] {
  return [...new Set([posix.join(userHome, '.codex'), posix.join(posix.dirname(dataDir), '.codex')])];
}

/**
 * The hub's own Codex home has no sign-in but an older place has one: pictures need a new sign-in (the old one is
 * never used, and never moved: it may be the user's own Codex).
 */
export function codexSignInMoved(dataDir: string, userHome: string, exists: (path: string) => boolean = existsSync): boolean {
  if (exists(posix.join(hubCodexHome(dataDir), 'auth.json'))) return false;
  return oldCodexSignIns(dataDir, userHome, exists).length > 0;
}

/** The sign-in files still at an old place: they hold live ChatGPT tokens, which a new sign-in does not end. */
export function oldCodexSignIns(dataDir: string, userHome: string, exists: (path: string) => boolean = existsSync): string[] {
  return oldCodexHomes(dataDir, userHome).map((dir) => posix.join(dir, 'auth.json')).filter(exists);
}

/** The one line the doctor and Settings show while codexSignInMoved holds. */
export const CODEX_SIGN_IN_AGAIN =
  "Pictures now use a ChatGPT sign-in of the hub's own, kept in its data folder: a sign-in made before this release is not used. Connect ChatGPT (pictures) again, and sign the old one out (codex logout) or delete its auth.json.";

const basePath = (base: NodeJS.ProcessEnv): string => base.PATH ?? '/usr/local/bin:/usr/bin:/bin';
const withoutApiKeys = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(base).filter(([key]) => !API_ENV.has(key)));

/**
 * The env for a Codex run (a picture, the sign-in): its home and CODEX_HOME both the hub's own Codex home, so nothing of
 * the user's `~/.codex` is read or changed; the user's .local/bin first on PATH; no API keys.
 */
export function codexEnv(home: string, codexDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...withoutApiKeys(base), HOME: codexDir, CODEX_HOME: codexDir, PATH: `${posix.join(home, '.local/bin')}:${basePath(base)}` };
}

/** The env for the nightly `npm install` of Codex: the user's own home (npm installs into its .local), no API keys. */
export function npmEnv(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...withoutApiKeys(base), HOME: home, PATH: `${posix.join(home, '.local/bin')}:${basePath(base)}` };
}

export interface RunOptions { env: NodeJS.ProcessEnv; cwd: string; input: string; timeoutMs: number; maxOutput: number; }
export interface RunResult { code: number | null; stdout: string; stderr: string; }
export type CodexRun = (file: string, args: readonly string[], opts: RunOptions) => Promise<RunResult>;

/** Spawns a program, writes `input` to its stdin and closes it; kills it at the timeout. Never rejects. */
export const spawnRun: CodexRun = (file, args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(file, [...args], { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    }, opts.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < opts.maxOutput) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < opts.maxOutput) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`.trim() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input);
  });
