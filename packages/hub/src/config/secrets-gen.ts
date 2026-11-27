import { randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { ValidationError } from '../core/errors.js';
import { parseEnvFile } from './env-file.js';
import { FILE_MODE, createFileExclusive, writeFileAtomic } from './files.js';

/** The two hub secrets generated on the first start: 32 random bytes each, as hex. */
export const GENERATED_SECRETS = ['SESSION_SECRET', 'HUB_SOCKET_TOKEN'] as const;
export type GeneratedSecret = (typeof GENERATED_SECRETS)[number];

const HEADER = '# Luady secrets (mode 0600). Generated values are never overwritten; SESSION_SECRET seals stored tokens.\n';

const newSecret = (): string => randomBytes(32).toString('hex');

function lines(names: readonly GeneratedSecret[]): string {
  return names.map((name) => `${name}=${newSecret()}\n`).join('');
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ValidationError(`cannot read the secrets file ${path}: ${(err as NodeJS.ErrnoException).code ?? 'unknown error'}`);
  }
}

/** The generated secrets a file lacks (a present but empty value counts as missing). */
function missingIn(text: string): GeneratedSecret[] {
  const entries = parseEnvFile(text);
  return GENERATED_SECRETS.filter((name) => (entries[name] ?? '') === '');
}

const LOCK_WAIT_MS = 50;
const LOCK_TRIES = 100;
/** A lock older than this was left by a process that died: it is removed. */
const STALE_LOCK_MS = 30_000;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `work` holding `<path>.lock` (an exclusive create), so two hubs starting at once never both add a secret. */
function withLock<T>(path: string, work: () => T): T {
  const lock = `${path}.lock`;
  for (let attempt = 0; attempt < LOCK_TRIES; attempt += 1) {
    let fd: number | null = null;
    try {
      fd = openSync(lock, 'wx', FILE_MODE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
      } catch {
        // gone meanwhile
      }
      pause(LOCK_WAIT_MS);
      continue;
    }
    closeSync(fd);
    try {
      return work();
    } finally {
      rmSync(lock, { force: true });
    }
  }
  throw new ValidationError(`the secrets file ${path} is locked by another start (${lock}); remove the lock if no hub is starting`);
}

/**
 * Makes sure the secrets file holds SESSION_SECRET and HUB_SOCKET_TOKEN, at mode 0600:
 * - no file: it is created atomically and only if still absent (never replacing a file another process just wrote);
 * - a file without one of them: the missing lines are appended, every existing line kept as it is (an atomic rewrite);
 * - a file with both: nothing is written.
 * A generated value is never logged or returned: the caller learns only which names were added.
 */
export function ensureSecrets(path: string): { readonly generated: readonly GeneratedSecret[] } {
  // Nothing to write (every start but the first): no lock is taken at all.
  const before = readOrNull(path);
  if (before !== null && missingIn(before).length === 0) return { generated: [] };
  return withLock(path, () => ensureLocked(path));
}

function ensureLocked(path: string): { readonly generated: readonly GeneratedSecret[] } {
  const existing = readOrNull(path);
  if (existing === null) {
    if (createFileExclusive(path, `${HEADER}${lines(GENERATED_SECRETS)}`, FILE_MODE)) return { generated: [...GENERATED_SECRETS] };
    return ensureLocked(path);
  }
  const missing = missingIn(existing);
  if (missing.length === 0) return { generated: [] };
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  writeFileAtomic(path, `${existing}${separator}${lines(missing)}`, FILE_MODE);
  return { generated: missing };
}
