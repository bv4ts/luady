import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';
import {
  HOST_PATH_RE, HostCreateBodySchema, HostLocalBodySchema, HostRemoveBodySchema, HostUpdateBodySchema, isUnderRoot,
  type HostCreateBody, type HostLocalBody, type HostRemoveBody, type HostUpdateBody,
} from '@luady/shared';
import { ValidationError } from '../core/errors.js';
import { HostConflictError, HostInvalidError } from './errors.js';
import { numericIpv4, refusedRange } from './resolve.js';

/**
 * Validation. The shared schemas give the grammar (host, user, port, paths, PIN; a new id is never reserved, so
 * neither `hq` nor `computer` can name an SSH host); this file adds what a grammar cannot say: proper DNS labels,
 * refused address literals (numeric forms included), ids never reused, and the local folder rules. The resolved
 * address is checked again at every scan and connect (hosts/resolve.ts).
 */

const LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.map(String).join('.') ?? '';
  throw new ValidationError(`Invalid ${field === '' ? 'request' : field}: ${issue?.message ?? 'not allowed'}`);
}

/** A host name or address the hub may scan and connect to (the text check; the resolved one follows at connect). */
export function checkAddress(host: string): string {
  const numeric = numericIpv4(host);
  const literal = numeric ?? (isIP(host) !== 0 ? host : null);
  if (literal !== null) {
    const reason = refusedRange(literal);
    if (reason !== null) throw new HostInvalidError('address_refused', `${host} is ${reason}, which the hub never connects to`);
    return host;
  }
  if (!host.split('.').every((label) => LABEL_RE.test(label))) throw new ValidationError('Invalid host: must be a host name or an IP address');
  return host;
}

export function parseCreateBody(input: unknown): HostCreateBody {
  const body = parse(HostCreateBodySchema, input);
  checkAddress(body.host);
  return body;
}

/**
 * "This computer": the page cannot know the hub user's home, so it may send `~/projects`; `~` and `~/…` are read as
 * that home here, before the schema (which wants an absolute path) checks the result.
 */
export function parseLocalBody(input: unknown, home: string): HostLocalBody {
  const body = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const root = body.projectsRoot;
  const expanded = typeof root === 'string' && (root === '~' || root.startsWith('~/'))
    ? { ...body, projectsRoot: `${home.replace(/\/+$/, '')}${root.slice(1)}` }
    : body;
  // The folder is the one field the owner types: a path the hub cannot use is refused for what it is.
  if (typeof expanded.projectsRoot === 'string' && !HOST_PATH_RE.test(expanded.projectsRoot)) {
    throw new HostInvalidError('folder_invalid', 'The projects folder must be a full path: letters, digits, dots, dashes and slashes');
  }
  return parse(HostLocalBodySchema, expanded);
}

export function parseUpdateBody(input: unknown): HostUpdateBody {
  const body = parse(HostUpdateBodySchema, input);
  if (body.host !== undefined) checkAddress(body.host);
  return body;
}

export function parseRemoveBody(input: unknown): HostRemoveBody {
  return parse(HostRemoveBodySchema, input);
}

/** Ids are immutable and never reused: any row, a tombstone or a config row included, holds its id. */
export function checkIdFree(id: string, existing: { state: string } | undefined): void {
  if (existing === undefined) return;
  throw new HostConflictError('host_exists', existing.state === 'removed'
    ? `${id} was used by a server that was removed; ids are never reused, so choose another`
    : `${id} is taken; choose another name`);
}

/**
 * One local row at most. A removed one may be made again: its id is fixed, and it is the same machine, so its kept
 * history belongs to it.
 */
export function checkLocalFree(existing: { state: string; source: string } | undefined): void {
  if (existing === undefined || (existing.state === 'removed' && existing.source === 'web')) return;
  throw new HostConflictError('local_exists', existing.source === 'config'
    ? 'This computer is set up in config.json already'
    : 'This computer is set up already');
}

/** The file system the local folder rules read and write (tests pass a fake). */
export interface FolderFs {
  kind(path: string): 'dir' | 'file' | null;
  realpath(path: string): string;
  mkdir(path: string, mode: number): void;
}

export const realFolderFs: FolderFs = {
  kind(path) {
    try {
      const info = lstatSync(path);
      return info.isDirectory() ? 'dir' : 'file';
    } catch {
      return null;
    }
  },
  realpath: (path) => realpathSync(path),
  mkdir: (path, mode) => mkdirSync(path, { mode }),
};

/**
 * This computer's projects folder: an existing folder is used as it is; a missing one is made only when the request
 * asks (`createFolder`), only inside the hub user's home, at 0700, with a parent that exists and does not lead out of
 * the home. Returns whether it was made.
 */
export function ensureLocalFolder(path: string, opts: { createFolder: boolean; home: string; disk?: FolderFs }): boolean {
  const disk = opts.disk ?? realFolderFs;
  const kind = disk.kind(path);
  if (kind === 'dir') return false;
  if (kind === 'file') throw new HostInvalidError('not_a_folder', `${path} is a file, not a folder`);
  if (!opts.createFolder) throw new HostInvalidError('folder_missing', `${path} does not exist`);
  if (path === opts.home || !isUnderRoot(path, opts.home)) {
    throw new HostInvalidError('folder_outside_home', `A new projects folder can only be made inside ${opts.home}`);
  }
  const parent = posix.dirname(path);
  if (disk.kind(parent) !== 'dir') throw new HostInvalidError('folder_parent_missing', `${parent} does not exist`);
  const realParent = disk.realpath(parent);
  const realHome = disk.realpath(opts.home);
  if (!isUnderRoot(realParent, realHome)) {
    throw new HostInvalidError('folder_outside_home', `A new projects folder can only be made inside ${opts.home}`);
  }
  disk.mkdir(path, 0o700);
  return true;
}

/** A local row takes no address: the website edits only its folders. */
export function checkLocalUpdate(body: HostUpdateBody): void {
  if (body.host !== undefined || body.user !== undefined || body.port !== undefined || body.homeDir !== undefined) {
    throw new HostInvalidError('local_fields', 'This computer has no address, user or port to change; only its folders');
  }
}

export type { HostCreateBody, HostLocalBody, HostRemoveBody, HostUpdateBody };
