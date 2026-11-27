import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { gzipSync } from 'node:zlib';
import { installRoot } from '../config/defaults.js';

/**
 * The kit payload: a deterministic tar.gz of `<install>/server-kit`, built in-process (no `tar`
 * binary, no shell), at most 5 MB, sent on stdin to the fixed `kit` script. The same tree always gives the same bytes
 * and the same sha256 on every machine: entries sorted, owner 0, fixed modes, one fixed mtime, gzip OS byte fixed.
 */
export const KIT_PAYLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** 2026-01-01T00:00:00Z: plausible for every tar, so none warns about an "implausibly old time stamp". */
const FIXED_MTIME = 1_767_225_600;
const BLOCK = 512;
const SKIPPED_DIRS = new Set(['tests', '__pycache__', '.pytest_cache', '.mypy_cache', 'node_modules']);
const EXECUTABLE_DIRS = new Set(['bin', 'hooks']);

export interface KitPayload {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly files: number;
}

interface Entry {
  readonly path: string;
  readonly dir: boolean;
  readonly data: Buffer;
}

function skipped(name: string, dir: boolean): boolean {
  if (dir) return SKIPPED_DIRS.has(name);
  return name.startsWith('Dockerfile') || name.endsWith('.pyc');
}

async function walk(root: string, rel: string, out: Entry[]): Promise<void> {
  const names = (await readdir(join(root, rel))).sort();
  for (const name of names) {
    const path = rel === '' ? name : posix.join(rel, name);
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink() || !(info.isDirectory() || info.isFile())) continue;
    if (skipped(name, info.isDirectory())) continue;
    if (info.isDirectory()) {
      out.push({ path: `${path}/`, dir: true, data: Buffer.alloc(0) });
      await walk(root, path, out);
      continue;
    }
    const data = await readFile(join(root, path));
    if (data.includes('\r\n')) throw new Error(`kit payload: ${path} has Windows line endings; check the kit out with LF endings`);
    out.push({ path, dir: false, data });
  }
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function modeOf(entry: Entry): number {
  if (entry.dir) return 0o755;
  return EXECUTABLE_DIRS.has(entry.path.split('/')[0] ?? '') ? 0o755 : 0o644;
}

/** One ustar header; long paths use the prefix field, split at a `/`. */
function header(entry: Entry): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  let name = entry.path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', name.length - 2);
    prefix = name.slice(0, cut);
    name = name.slice(cut + 1);
    if (cut <= 0 || Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`kit payload: path too long: ${entry.path}`);
  }
  block.write(name, 0, 100, 'utf8');
  block.write(octal(modeOf(entry), 8), 100, 8, 'ascii');
  block.write(octal(0, 8), 108, 8, 'ascii');
  block.write(octal(0, 8), 116, 8, 'ascii');
  block.write(octal(entry.data.length, 12), 124, 12, 'ascii');
  block.write(octal(FIXED_MTIME, 12), 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write(entry.dir ? '5' : '0', 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write(prefix, 345, 155, 'utf8');
  const sum = block.reduce((total, byte) => total + byte, 0);
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

/** A ustar archive of the entries, in order, ending with two empty blocks. */
export function tarOf(entries: readonly Entry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry));
    if (entry.dir) continue;
    parts.push(entry.data);
    const pad = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
    if (pad > 0) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 2, 0));
  return Buffer.concat(parts);
}

/** gzip with the header's OS byte fixed to Unix (zlib writes the build platform's), so Windows and Linux agree. */
function gzipFixed(data: Buffer): Buffer {
  const out = gzipSync(data, { level: 9 });
  out[9] = 3;
  return out;
}

/** Builds the payload from `<root>/server-kit` (tests/, __pycache__/ and Dockerfile* left out). */
export async function buildKitPayload(root: string = installRoot(), maxBytes: number = KIT_PAYLOAD_MAX_BYTES): Promise<KitPayload> {
  const entries: Entry[] = [];
  await walk(join(root, 'server-kit'), '', entries);
  if (!entries.some((entry) => entry.path === 'install.py')) throw new Error('kit payload: server-kit/install.py is missing');
  const bytes = gzipFixed(tarOf(entries));
  if (bytes.length > maxBytes) throw new Error(`kit payload: ${bytes.length} bytes is over the ${maxBytes}-byte limit`);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), files: entries.filter((entry) => !entry.dir).length };
}

/** Builds the payload once and keeps it (the kit is part of the release, it does not change while the hub runs). */
export function cachedKitPayload(root?: string): () => Promise<KitPayload> {
  let made: Promise<KitPayload> | null = null;
  return () => {
    made ??= buildKitPayload(root).catch((err: unknown) => {
      made = null;
      throw err;
    });
    return made;
  };
}
