import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync, type Stats } from 'node:fs';
import { posix } from 'node:path';
import { ensureDir, writeFileAtomic } from '../config/files.js';

const { dirname, join } = posix;

/**
 * Seeding the manager's folder from the release's `brain/`:
 * - user-owned files (`memory/**`, `journal/**`, `LOCAL.md`, `workspace/**`, `inbox/**`) are created when missing and
 *   never overwritten;
 * - release-owned files (`CLAUDE.md`, `skills/**`, anything else) are replaced when the release changes, keeping a
 *   `.bak` of a file the owner changed;
 * - `README.md` (developer notes) and `.manager/` (rendered, luady/render.ts) are not seeded.
 * A manifest (`.manager/seed.json`) remembers the release and what was written, so a local edit is told apart from an
 * older release's copy.
 */
export const USER_OWNED_DIRS = ['memory/', 'journal/', 'workspace/', 'inbox/'] as const;
export const USER_OWNED_FILES = ['LOCAL.md'] as const;
const NOT_SEEDED_FILES = new Set(['README.md']);
const NOT_SEEDED_DIRS = ['.manager/'];
export const SEED_MANIFEST = '.manager/seed.json';

export function isUserOwned(path: string): boolean {
  return (USER_OWNED_FILES as readonly string[]).includes(path) || USER_OWNED_DIRS.some((dir) => path.startsWith(dir));
}

function isSeeded(path: string): boolean {
  return !NOT_SEEDED_FILES.has(path) && !NOT_SEEDED_DIRS.some((dir) => path.startsWith(dir));
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Every file under `root`, as POSIX paths relative to it, sorted. Symbolic links are not followed. */
function listFiles(root: string, prefix = ''): string[] {
  const here = join(root, prefix);
  return readdirSync(here, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return listFiles(root, rel);
    return entry.isFile() ? [rel] : [];
  }).sort();
}

interface Manifest {
  readonly release: string;
  readonly files: Readonly<Record<string, string>>;
}

function readManifest(target: string): Manifest | null {
  try {
    const parsed = JSON.parse(readFileSync(join(target, SEED_MANIFEST), 'utf8')) as Partial<Manifest>;
    if (typeof parsed.release !== 'string' || typeof parsed.files !== 'object' || parsed.files === null) return null;
    return { release: parsed.release, files: parsed.files };
  } catch {
    return null;
  }
}

/**
 * What is at a path, never following a symbolic link: nothing, a regular file (with its hash), or something else (a
 * link, a folder, a device), which the seed leaves alone: it neither replaces it nor copies what it points at.
 */
type Found = { readonly kind: 'missing' } | { readonly kind: 'file'; readonly hash: string } | { readonly kind: 'other' };

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function foundAt(path: string): Found {
  const stats = lstatOrNull(path);
  if (stats === null) return { kind: 'missing' };
  return stats.isFile() ? { kind: 'file', hash: sha256(readFileSync(path)) } : { kind: 'other' };
}

const BACKSLASH = String.fromCharCode(92);
const NUL = String.fromCharCode(0);

/** A path inside `target`: relative, POSIX, no `.` or `..` segment, and every folder on the way a real folder in it. */
function safeTarget(target: string, rel: string): string | null {
  const segments = rel.split('/');
  if (rel === '' || rel.startsWith('/') || rel.includes(BACKSLASH) || rel.includes(NUL)) return null;
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  let dir = target;
  for (const segment of segments.slice(0, -1)) {
    dir = join(dir, segment);
    const stats = lstatOrNull(dir);
    if (stats !== null && !stats.isDirectory()) return null;
  }
  return join(target, rel);
}

/** `<file>.bak`, or `<file>.bak.2`, `.bak.3` … so that no earlier backup is ever lost. */
function backupPath(file: string): string {
  if (!existsSync(`${file}.bak`)) return `${file}.bak`;
  let n = 2;
  while (existsSync(`${file}.bak.${n}`)) n += 1;
  return `${file}.bak.${n}`;
}

function copy(data: Buffer, to: string): void {
  ensureDir(dirname(to));
  writeFileAtomic(to, data, 0o600);
}

export interface SeedResult {
  readonly release: string;
  readonly created: readonly string[];
  readonly replaced: readonly string[];
  /** Locally changed release files: the owner's copy is kept at this path before the release copy goes in. */
  readonly backedUp: ReadonlyArray<{ readonly path: string; readonly backup: string }>;
  readonly removed: readonly string[];
  /** Paths left alone because something that is not a regular file (a link, a folder) is there, or on the way there. */
  readonly skipped: readonly string[];
}

/** Seeds `target` from `source`. Idempotent: a second run with the same release writes nothing. */
export function seedBrain(source: string, target: string): SeedResult {
  ensureDir(target);
  const files = listFiles(source).filter(isSeeded);
  const data = new Map(files.map((path) => [path, readFileSync(join(source, path))]));
  const hashes = new Map([...data].map(([path, bytes]) => [path, sha256(bytes)]));
  const releaseFiles = files.filter((path) => !isUserOwned(path));
  const release = sha256(Buffer.from(releaseFiles.map((path) => `${path}:${hashes.get(path) ?? ''}`).join('\n')));
  const manifest = readManifest(target);
  const changed = manifest?.release !== release;
  const created: string[] = [];
  const replaced: string[] = [];
  const backedUp: Array<{ path: string; backup: string }> = [];
  const skipped: string[] = [];

  for (const path of files) {
    const to = safeTarget(target, path);
    const bytes = data.get(path) ?? Buffer.alloc(0);
    const found = to === null ? ({ kind: 'other' } as const) : foundAt(to);
    if (to === null || found.kind === 'other') {
      skipped.push(path);
      continue;
    }
    if (found.kind === 'missing') {
      copy(bytes, to);
      created.push(path);
      continue;
    }
    const current = found.hash;
    if (isUserOwned(path) || !changed || current === hashes.get(path)) continue;
    // The release changed and this copy differs: the owner's edit is kept aside unless it is our own older copy.
    if (manifest?.files[path] !== current) {
      const backup = backupPath(to);
      copy(readFileSync(to), backup);
      backedUp.push({ path, backup });
    }
    copy(bytes, to);
    replaced.push(path);
  }

  // A file an older release wrote and this one dropped goes, if it is still exactly our copy and inside the folder.
  const removed = changed && manifest !== null
    ? Object.keys(manifest.files).filter((path) => {
      const at = safeTarget(target, path);
      if (at === null || hashes.has(path) || isUserOwned(path) || !isSeeded(path)) return false;
      const found = foundAt(at);
      return found.kind === 'file' && found.hash === manifest.files[path];
    })
    : [];
  for (const path of removed) rmSync(join(target, path), { force: true });

  if (changed || created.length > 0) {
    const written = Object.fromEntries(releaseFiles.map((path) => [path, hashes.get(path) ?? '']));
    writeFileAtomic(join(target, SEED_MANIFEST), `${JSON.stringify({ release, files: written }, null, 2)}\n`, 0o600);
  }
  return { release, created, replaced, backedUp, removed, skipped };
}
