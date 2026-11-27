import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, posix, sep } from 'node:path';
import type { ToolName } from '@luady/shared';
import type { ToolHandler } from '../core/contracts.js';
import { NotFoundError, RefusedError, ValidationError } from '../core/errors.js';
import { FILE_PUT_MAX, UPLOAD_NAME_RE } from '../fleet/ctl-args.js';
import { defineTool } from './common.js';

const NAME_MAX = 128;

/** A server-safe version of an owner's file name: [A-Za-z0-9._-], no leading dot, at most 128 chars. */
export function uploadName(fileName: string): string {
  const rawExt = posix.extname(fileName);
  const ext = /^\.[A-Za-z0-9]{1,15}$/.test(rawExt) ? rawExt : '';
  const stem = fileName
    .slice(0, fileName.length - rawExt.length)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, NAME_MAX - ext.length);
  const name = `${stem || 'file'}${ext}`;
  return UPLOAD_NAME_RE.test(name) ? name : 'file';
}

/** Resolves `file` to a regular file inside the inbox (symlinks and `..` cannot escape it). */
export async function inboxFile(inboxDir: string, file: string): Promise<{ path: string; size: number }> {
  if (!isAbsolute(file)) throw new ValidationError('file must be an absolute path in the inbox');
  let real: string;
  let root: string;
  try {
    [real, root] = await Promise.all([realpath(file), realpath(inboxDir)]);
  } catch {
    throw new NotFoundError(`No such file in the inbox: ${file}`);
  }
  if (!real.startsWith(`${root}${sep}`)) throw new RefusedError('file_upload only sends files the owner sent (the brain inbox)');
  const info = await stat(real);
  if (!info.isFile()) throw new ValidationError(`${file} is not a regular file`);
  if (info.size === 0) throw new ValidationError(`${file} is empty`);
  if (info.size > FILE_PUT_MAX) throw new ValidationError(`${file} is ${Math.round(info.size / 1048576)} MB; the limit is 50 MB`);
  return { path: real, size: info.size };
}

export const UPLOAD_TOOLS = {
  file_upload: defineTool('file_upload', async (args, ctx) => {
    const local = await inboxFile(ctx.inboxDir, args.file);
    const name = args.name ?? uploadName(basename(local.path).replace(/^\d{8}-\d{6}-[A-Za-z0-9]{1,12}-/, ''));
    const b64 = (await readFile(local.path)).toString('base64');
    const put = await ctx.fleet.client(args.server).filePut(name, b64);
    return `Uploaded to ${args.server}:${put.path} (${Math.max(1, Math.round(put.size / 1024))} KB). Give this exact path to the session.`;
  }),
} satisfies Partial<Record<ToolName, ToolHandler>>;
