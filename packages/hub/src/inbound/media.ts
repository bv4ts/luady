import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join, posix } from 'node:path';
import type { MediaRef } from '@luady/shared';
import { INBOX_FILE_MAX_BYTES } from '../channels/budgets.js';
import { FileTooBigError, copyCapped, openAddonFile } from '../channels/paths.js';

/** Files the owner sends are kept in the brain inbox this long, then pruned. */
export const INBOX_KEEP_MS = 14 * 24 * 60 * 60_000;
const NAME_MAX = 100;

const pad = (value: number): string => String(value).padStart(2, '0');

/** `YYYYMMDD-HHMMSS-<msgId8>-<safe name>` (UTC): sortable, unique per message, safe on any file system. */
export function inboxName(msgId: string, fileName: string, nowMs: number): string {
  const at = new Date(nowMs);
  const date = `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;
  const time = `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  const id = msgId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'msg';
  const rawExt = posix.extname(fileName);
  const ext = /^\.[A-Za-z0-9]{1,15}$/.test(rawExt) ? rawExt : '';
  const stem = fileName.slice(0, fileName.length - rawExt.length)
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[^A-Za-z0-9]+/, '').slice(0, NAME_MAX);
  return `${date}-${time}-${id}-${stem || 'file'}${ext}`;
}

export interface MediaImport {
  /** `<dataDir>/addons/<id>/files/`: the only folder this add-on's files may come from. */
  readonly root: string;
  /** The brain inbox, where the manager reads what the owner sent. */
  readonly inboxDir: string;
  readonly msgId: string;
  readonly nowMs: number;
  /** The biggest file copied in; INBOX_FILE_MAX_BYTES by default. */
  readonly maxBytes?: number;
}

/**
 * An add-on's file, checked (its real path inside the add-on's own files folder) and copied into the
 * brain inbox, where the manager may read it. A path that fails the check is dropped and the reason kept as the error;
 * the add-on's own path never reaches the manager.
 */
export async function importMedia<M extends MediaRef>(media: M, where: MediaImport): Promise<M> {
  if (media.path === null) return media;
  // Opened first, then checked (its real path inside the folder, and still the same file), then read from that handle.
  const opened = await openAddonFile(where.root, media.path);
  if (!opened.ok) return { ...media, path: null, error: `the file was refused (${opened.reason})` };
  try {
    await mkdir(where.inboxDir, { recursive: true, mode: 0o750 });
    const target = join(where.inboxDir, inboxName(where.msgId, media.fileName ?? posix.basename(opened.path), where.nowMs));
    const size = await copyCapped(opened.handle, target, where.maxBytes ?? INBOX_FILE_MAX_BYTES, 0o640);
    return { ...media, path: target, size: media.size ?? size };
  } catch (err) {
    const why = err instanceof FileTooBigError ? err.message : `it could not be kept: ${err instanceof Error ? err.message : String(err)}`;
    return { ...media, path: null, error: `the file was refused (${why})` };
  }
}

/** Deletes inbox files older than `keepMs`; returns how many went. A missing folder means nothing to do. */
export async function pruneInbox(dir: string, nowMs: number, keepMs = INBOX_KEEP_MS): Promise<number> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile() || nowMs - info.mtimeMs <= keepMs) continue;
    if (await unlink(path).then(() => true, () => false)) removed += 1;
  }
  return removed;
}
