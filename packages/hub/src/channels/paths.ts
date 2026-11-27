import { constants, type Stats } from 'node:fs';
import { open, realpath, rm, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Why a file an add-on named was refused (logged and told to the add-on; the path itself is never echoed back). */
export type PathRefusal = 'not-absolute' | 'missing' | 'outside' | 'not-a-file' | 'changed';

/** Which file a checked path named: compared again when the file is opened to be read. */
export interface FileIdentity { readonly dev: number; readonly ino: number }

export type ConfinedPath =
  | { readonly ok: true; readonly path: string; readonly size: number; readonly identity: FileIdentity }
  | { readonly ok: false; readonly reason: PathRefusal };

export type OpenedFile =
  | { readonly ok: true; readonly handle: FileHandle; readonly path: string; readonly size: number; readonly identity: FileIdentity }
  | { readonly ok: false; readonly reason: PathRefusal };

/** True when `child` is below `root` (both already real paths). */
function within(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** Two stats name the same file; a platform without inode numbers (0) cannot tell, so only the device is compared. */
export function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  if (a.dev !== b.dev) return false;
  return a.ino === 0 || b.ino === 0 || a.ino === b.ino;
}

const identityOf = (info: Stats): FileIdentity => ({ dev: info.dev, ino: info.ino });

/**
 * A file an add-on hands over (`MediaRef.path`, `deliver.file.path`) must be a regular file whose real
 * path (links followed) is inside its own `<dataDir>/addons/<id>/files/`. The file is opened first; then its real
 * path is checked and the open handle's device and inode are compared with what that path names, so a file swapped
 * in between the check and the read is refused. The caller reads from the handle (and closes it).
 */
export async function openAddonFile(root: string, path: string): Promise<OpenedFile> {
  if (!isAbsolute(path) || path.includes('\0')) return { ok: false, reason: 'not-absolute' };
  /** Where the path really leads: outside the folder, or inside but not a plain file. */
  const placed = async (): Promise<{ ok: false; reason: PathRefusal }> => {
    try {
      const [realRoot, real] = await Promise.all([realpath(root), realpath(path)]);
      return { ok: false, reason: within(realRoot, real) ? 'not-a-file' : 'outside' };
    } catch {
      return { ok: false, reason: 'missing' };
    }
  };
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY);
  } catch {
    // A folder (on some platforms) or nothing at all.
    return placed();
  }
  const refuse = async (reason: PathRefusal): Promise<OpenedFile> => {
    await handle.close().catch(() => undefined);
    return { ok: false, reason };
  };
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      await handle.close().catch(() => undefined);
      return placed();
    }
    const [realRoot, real] = await Promise.all([realpath(root), realpath(path)]);
    if (!within(realRoot, real)) return await refuse('outside');
    const named = await stat(real);
    if (!named.isFile() || !sameFile(identityOf(opened), identityOf(named))) return await refuse('changed');
    return { ok: true, handle, path: real, size: opened.size, identity: identityOf(opened) };
  } catch {
    return refuse('missing');
  }
}

/** The check alone: the real path, its size and identity (the handle is closed again). */
export async function confineAddonFile(root: string, path: string): Promise<ConfinedPath> {
  const opened = await openAddonFile(root, path);
  if (!opened.ok) return opened;
  await opened.handle.close();
  return { ok: true, path: opened.path, size: opened.size, identity: opened.identity };
}

/** A copy refused because the file is bigger than the cap. */
export class FileTooBigError extends Error {
  constructor(readonly maxBytes: number) {
    super(`the file is bigger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
    this.name = 'FileTooBigError';
  }
}

/**
 * Copies an open file into a new file at `target` (never overwriting), stopping as soon as more than `maxBytes` came
 * through: the size is checked before the copy and counted during it, so a file that grows meanwhile is cut off.
 * The source handle is closed; a refused or failed copy leaves no target behind. Returns the bytes copied.
 */
export async function copyCapped(source: FileHandle, target: string, maxBytes: number, mode: number): Promise<number> {
  let sink: FileHandle;
  try {
    if ((await source.stat()).size > maxBytes) throw new FileTooBigError(maxBytes);
    sink = await open(target, 'wx', mode);
  } catch (err) {
    await source.close().catch(() => undefined);
    throw err;
  }
  let total = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      total += chunk.length;
      done(total > maxBytes ? new FileTooBigError(maxBytes) : null, total > maxBytes ? undefined : chunk);
    },
  });
  try {
    await pipeline(source.createReadStream({ start: 0 }), counter, sink.createWriteStream());
    return total;
  } catch (err) {
    await rm(target, { force: true }).catch(() => undefined);
    throw err;
  }
}
