import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Owner-only modes. */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Creates a folder (and its missing parents) at 0700. An existing folder keeps its mode; modes.ts tightens it. */
export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: DIR_MODE });
}

/** Writes a new temporary file next to `path` at `mode`, flushed to disk; returns its path. */
function writeTemp(path: string, data: string | Uint8Array, mode: number): string {
  const temp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', mode);
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return temp;
}

/** Replaces `path` with `data` atomically (a temporary file, then a rename), at `mode`. */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode: number = FILE_MODE): void {
  ensureDir(dirname(path));
  const temp = writeTemp(path, data, mode);
  try {
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * Creates `path` with `data` atomically and only if it does not exist (a temporary file, then a hard link, which never
 * replaces an existing file). Returns false when the file was already there: nothing is overwritten.
 */
export function createFileExclusive(path: string, data: string | Uint8Array, mode: number = FILE_MODE): boolean {
  ensureDir(dirname(path));
  const temp = writeTemp(path, data, mode);
  try {
    linkSync(temp, path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // A file system without hard links: an exclusive create still never replaces an existing file.
    if (code === 'EPERM' || code === 'ENOTSUP' || code === 'ENOSYS') return createDirect(path, data, mode);
    throw err;
  } finally {
    rmSync(temp, { force: true });
  }
}

function createDirect(path: string, data: string | Uint8Array, mode: number): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx', mode);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}
