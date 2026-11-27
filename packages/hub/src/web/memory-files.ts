import type { Dirent } from 'node:fs';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { NotFoundError, RefusedError, ValidationError } from '../core/errors.js';

export const MEMORY_DIR_NAME = 'memory';
export const MEMORY_FILE_MAX_BYTES = 1_000_000;
export const MEMORY_MAX_DEPTH = 8;
export const MEMORY_MAX_FILES = 2000;

export interface MemoryFileEntry {
  name: string;
  size: number;
}

export interface MemoryFileContent {
  name: string;
  content: string;
}

export function memoryRoot(brainDir: string): string {
  return resolve(brainDir, MEMORY_DIR_NAME);
}

/** True when target is strictly below root: a prefix check that includes the separator, never a substring match. */
export function isInside(root: string, target: string): boolean {
  const base = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(base);
}

/** path.resolve plus a prefix check. Symlinks and junctions are checked with realpath when the file is read. */
export function resolveMemoryPath(root: string, name: string): string {
  if (name.includes('\0') || isAbsolute(name)) throw new ValidationError('Invalid memory file name');
  const target = resolve(root, name);
  if (!isInside(root, target)) throw new ValidationError('Memory file name escapes the memory directory');
  return target;
}

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
}

async function realpathOrMissing(path: string, name: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if (isMissing(err)) throw new NotFoundError(`Memory file not found: ${name}`);
    throw err;
  }
}

export async function readMemoryFile(root: string, name: string): Promise<MemoryFileContent> {
  const target = resolveMemoryPath(root, name);
  const realRoot = await realpathOrMissing(root, name);
  const realTarget = await realpathOrMissing(target, name);
  if (!isInside(realRoot, realTarget)) throw new ValidationError('Memory file name escapes the memory directory');
  const info = await stat(realTarget);
  if (!info.isFile()) throw new NotFoundError(`Memory file not found: ${name}`);
  if (info.size > MEMORY_FILE_MAX_BYTES) throw new RefusedError('Memory file is too large to display');
  return { name, content: await readFile(realTarget, 'utf8') };
}

async function readEntries(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

async function visit(dir: string, prefix: string, depth: number, entry: Dirent): Promise<MemoryFileEntry[]> {
  const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  const full = join(dir, entry.name);
  // Dirent types do not follow links: symlinks and junctions are neither isDirectory nor isFile.
  if (entry.isDirectory()) return walk(full, name, depth + 1);
  if (!entry.isFile() || !entry.name.endsWith('.md')) return [];
  const size = await sizeOf(full);
  return size === null ? [] : [{ name, size }];
}

async function walk(dir: string, prefix: string, depth: number): Promise<MemoryFileEntry[]> {
  if (depth > MEMORY_MAX_DEPTH) return [];
  const entries = await readEntries(dir);
  const nested = await Promise.all(entries.map((entry) => visit(dir, prefix, depth, entry)));
  return nested.flat();
}

function byName(a: MemoryFileEntry, b: MemoryFileEntry): number {
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/** `*.md` under the memory dir, recursive, with relative '/'-separated names sorted by code unit. */
export async function listMemoryFiles(root: string): Promise<MemoryFileEntry[]> {
  const files = await walk(root, '', 0);
  return [...files].sort(byName).slice(0, MEMORY_MAX_FILES);
}
