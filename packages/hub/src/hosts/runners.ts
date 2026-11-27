import { spawn } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { posix } from 'node:path';
import { z } from 'zod';
import { LOCAL_HOST_ID } from '@luady/shared';
import { installRoot } from '../config/defaults.js';
import type { Logger } from '../core/contracts.js';
import { createLineBuffer } from '../ingest/line-buffer.js';
import type { DynamicFleet } from '../fleet/fleet-core.js';
import type { ExecOptions, ExecResult } from '../fleet/executor.js';
import type { FixedScriptId } from '../fleet/fixed-scripts.js';
import { scanHostKey, type ScanResult, type ScanTarget } from '../fleet/host-scan.js';
import { userEnv } from '../fleet/local-env.js';
import {
  KIT_INSTALL_TIMEOUT_MS, installLocalKit, installedKitAlias, installedKitVersion, preflight as localPreflight, type Preflight,
} from '../fleet/local-kit.js';
import { HostReachError } from './errors.js';
import type { KitPayload } from './kit-payload.js';
import { realFolderFs, type FolderFs } from './validate.js';

/**
 * The three seams the hosts service reaches the outside through: the scanner, the kit runner (the
 * fixed scripts on an SSH host) and this computer's kit. Production passes the real ones below; demo mode passes
 * fakes, so nothing touches a socket or spawns a process.
 */
export interface HostScanner {
  scan(target: ScanTarget): Promise<ScanResult>;
}

/** What one kit run ended with: the installer's summary when it gave one. */
export interface KitOutcome {
  readonly code: number | null;
  readonly summary: KitSummaryLite | null;
  /** The installer's own error text, bounded; never shown raw without cleaning. */
  readonly error: string | null;
}

/** The kit's own grammars (server-kit install.py): a version, and a host alias. */
const KIT_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const KIT_ALIAS_RE = /^[A-Za-z0-9._-]{1,32}$/;

export const KitSummaryLiteSchema = z.object({
  ok: z.literal(true),
  action: z.enum(['install', 'uninstall']),
  version: z.string().regex(KIT_VERSION_RE).optional(),
  host_alias: z.string().regex(KIT_ALIAS_RE).optional(),
  settings: z.string().max(300).nullable().optional(),
  backup: z.string().max(300).nullable().optional(),
  statusline: z.string().max(80).optional(),
  steps: z.string().max(120).optional(),
}).loose();
export type KitSummaryLite = z.infer<typeof KitSummaryLiteSchema>;

/** The kit runner: only the fixed scripts, only on a pinned SSH host's own link. */
export interface RemoteRunner {
  /** The preflight script's stdout (hostile text, parsed by hosts/preflight.ts). */
  preflight(host: string, args: { claudeBin: string | null; projectsRoot: string | null }): Promise<string>;
  /** The kit script with the payload on stdin; every output line goes to `onLine` (cleaned there). */
  kit(host: string, args: readonly string[], payload: KitPayload, onLine: (line: string) => void, opts?: { timeoutMs?: number }): Promise<KitOutcome>;
  /** The key-remove script: every line holding the blob goes. */
  removeKey(host: string, blob: string): Promise<'removed' | 'absent'>;
}

/** This computer's kit (fleet/local-kit.ts), plus what the local host needs to know about its own user. */
export interface LocalKit {
  home(): string;
  user(): string;
  platform(): NodeJS.Platform;
  readonly folders: FolderFs;
  preflight(claudeBin: string): Promise<Preflight>;
  installedAlias(home: string): Promise<string | null>;
  installedVersion(home: string): Promise<string | null>;
  install(opts: { projectsRoot: string; claudeBin: string }, onLine: (line: string) => void): Promise<KitSummaryLite>;
  uninstall(onLine: (line: string) => void, opts?: { timeoutMs?: number }): Promise<KitSummaryLite>;
}

export const realScanner: HostScanner = { scan: (target) => scanHostKey(target) };

const ERROR_MAX = 300;

/** The last JSON line of the output, read with the summary schema; null when there is none. */
export function lastSummary(stdout: string): KitSummaryLite | null {
  const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('{'));
  const last = lines.at(-1);
  if (last === undefined) return null;
  try {
    const parsed = KitSummaryLiteSchema.safeParse(JSON.parse(last));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The installer's `{"ok": false, "error": …}` from stderr, bounded; else null. */
export function installerError(stderr: string): string | null {
  for (const line of stderr.split('\n').reverse()) {
    try {
      const parsed = JSON.parse(line.trim()) as { error?: unknown };
      if (typeof parsed.error === 'string') return parsed.error.slice(0, ERROR_MAX);
    } catch {
      continue;
    }
  }
  return null;
}

function lineFeeder(onLine: (line: string) => void): { feed(chunk: Buffer): void; flush(): void } {
  const buffer = createLineBuffer(64 * 1024);
  return {
    feed: (chunk) => {
      for (const line of buffer.push(chunk)) onLine(line);
    },
    flush: () => {
      const rest = buffer.pending();
      if (rest.trim() !== '') onLine(rest);
    },
  };
}

/** The kit runner over the fleet's own links: `runFixed` on the host's executor, nothing else. */
export function createSshRunner(deps: { fleet: Pick<DynamicFleet, 'executor'>; log: Logger }): RemoteRunner {
  async function run(host: string, id: FixedScriptId, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const executor = deps.fleet.executor(host);
    if (executor?.runFixed === undefined || executor.status() !== 'online') throw new HostReachError('unreachable', `${host} is not connected`);
    return executor.runFixed(id, args, opts);
  }
  return {
    async preflight(host, args) {
      const result = await run(host, 'preflight', [args.claudeBin ?? '', args.projectsRoot ?? ''], { timeoutMs: 20_000, maxOutputBytes: 16 * 1024 });
      return result.stdout;
    },
    async kit(host, args, payload, onLine, opts = {}) {
      const out = lineFeeder(onLine);
      const err = lineFeeder(onLine);
      const result = await run(host, 'kit', args, {
        stdinBytes: payload.bytes, timeoutMs: opts.timeoutMs ?? KIT_INSTALL_TIMEOUT_MS, maxOutputBytes: 256 * 1024,
        onStdout: (chunk) => out.feed(chunk), onStderr: (chunk) => err.feed(chunk),
      });
      out.flush();
      err.flush();
      return { code: result.code, summary: result.code === 0 ? lastSummary(result.stdout) : null, error: installerError(result.stderr) };
    },
    async removeKey(host, blob) {
      const result = await run(host, 'key-remove', [blob], { timeoutMs: 20_000, maxOutputBytes: 4096 });
      const said = result.stdout.trim();
      if (result.code === 0 && (said === 'removed' || said === 'absent')) return said;
      deps.log.warn({ host, code: result.code }, 'hosts: key-remove did not finish');
      throw new Error('the key line could not be removed');
    },
  };
}

/** `python3 <install>/server-kit/install.py --uninstall` for this computer: an argv array, no shell. */
function uninstallLocal(onLine: (line: string) => void, timeoutMs: number = KIT_INSTALL_TIMEOUT_MS, root: string = installRoot()): Promise<KitSummaryLite> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [posix.join(root, 'server-kit', 'install.py'), '--uninstall'], {
      shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: userEnv(),
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const err = lineFeeder(onLine);
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk);
      err.feed(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`cannot run python3: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      err.flush();
      const summary = lastSummary(Buffer.concat(stdout).toString('utf8'));
      if (code === 0 && summary !== null) resolve(summary);
      else reject(new Error(installerError(Buffer.concat(stderr).toString('utf8')) ?? `the uninstaller stopped (exit ${code ?? 'signal'})`));
    });
  });
}

function hubUser(): string {
  try {
    return userInfo().username;
  } catch {
    return 'owner';
  }
}

/** This computer's kit, for real: the user's own HOME and environment. */
export const realLocalKit: LocalKit = {
  home: () => homedir(),
  user: hubUser,
  platform: () => process.platform,
  folders: realFolderFs,
  preflight: (claudeBin) => localPreflight({ claudeBin, env: userEnv() }),
  installedAlias: (home) => installedKitAlias(home),
  installedVersion: (home) => installedKitVersion(home),
  async install(opts, onLine) {
    const summary = await installLocalKit({ ...opts, alias: LOCAL_HOST_ID, env: userEnv() }, onLine);
    return KitSummaryLiteSchema.parse(summary);
  },
  uninstall: (onLine, opts = {}) => uninstallLocal(onLine, opts.timeoutMs),
};
