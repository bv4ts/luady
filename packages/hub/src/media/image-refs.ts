import { readdirSync, realpathSync, statSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { isHostId, isSelfHost, type HostId } from '@luady/shared';
import { NotFoundError, RefusedError, ValidationError } from '../core/errors.js';
import { referencesDeniedPath } from '../security/risk-paths.js';

export const REFERENCE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_ID_RE = /^(img-[0-9a-f]{8})(?:#(\d{1,2}))?$/;
const IMAGE_FILE_RE = /^image-(\d+)\.(png|jpe?g|webp)$/i;
const SERVER_RE = /^([A-Za-z][A-Za-z0-9_-]+):(?!\/\/)(.*)$/;
const SHORT_MAX = 60;

/** Where a reference's bytes come from once the job runs. */
export type RefSource =
  | { kind: 'file'; path: string }
  | { kind: 'server'; server: HostId; path: string }
  | { kind: 'url'; url: string };

export interface RefDirs {
  /** The brain inbox: local references must really be inside it. */
  inboxDir: string;
  /** Finished images, one folder per id (img-xxxxxxxx/image-N.png). */
  imagesDir: string;
  /** Which hosts are servers of the fleet (ids are open); without it only the id grammar is checked. */
  hasServer?: (id: string) => boolean;
}

export interface RefFetchers {
  fetchServerFile(server: HostId, path: string): Promise<Buffer>;
  fetchUrl(url: string): Promise<Buffer>;
}

/** A source for the owner's eyes: at most 60 characters. */
export function shortSource(source: string): string {
  return source.length <= SHORT_MAX ? source : `${source.slice(0, SHORT_MAX - 1)}…`;
}

function inboxFile(path: string, inboxDir: string): RefSource {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new NotFoundError(`${path} does not exist`);
  }
  let root = inboxDir;
  try {
    root = realpathSync(inboxDir);
  } catch {
    // no inbox yet: nothing can be inside it
  }
  const inside = relative(root, real);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new RefusedError(`Only pictures under ${inboxDir}/ can be used as local references`);
  const info = statSync(real);
  if (!info.isFile()) throw new ValidationError(`${path} is not a file`);
  if (info.size > REFERENCE_MAX_BYTES) throw new RefusedError(`${path} is too big for a reference (max 20 MB)`);
  return { kind: 'file', path: real };
}

/** image-1.png, image-2.png, … of an earlier image job, in number order. */
export function jobImages(imagesDir: string, id: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(imagesDir, id));
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, n: Number(IMAGE_FILE_RE.exec(name)?.[1] ?? NaN) }))
    .filter((entry) => !Number.isNaN(entry.n))
    .sort((a, b) => a.n - b.n)
    .map((entry) => join(imagesDir, id, entry.name));
}

function earlierImage(id: string, index: number, imagesDir: string): RefSource {
  const files = jobImages(imagesDir, id);
  if (files.length === 0) throw new NotFoundError(`No image ${id} (it was never made, failed, or was pruned after 14 days)`);
  const file = files[index - 1];
  if (file === undefined) throw new NotFoundError(`Image ${id} has only ${files.length} picture(s)`);
  return { kind: 'file', path: file };
}

function serverFile(server: string, path: string, hasServer: RefDirs['hasServer']): RefSource {
  const known = isHostId(server) && !isSelfHost(server) && (hasServer?.(server) ?? true);
  if (!known) throw new ValidationError(`${server}: is not a server of the fleet; use <server>:/path with one of your servers`);
  if (!path.startsWith('/')) throw new ValidationError(`${server}:${path} needs an absolute path, like ${server}:/home/dev/x.png`);
  if (referencesDeniedPath(path)) throw new RefusedError(`${path} is a protected path`);
  return { kind: 'server', server: server as HostId, path };
}

function link(source: string): RefSource {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new ValidationError(`${shortSource(source)} is not a valid link`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') throw new ValidationError(`${shortSource(source)} is not an http(s) link`);
  if (url.username !== '' || url.password !== '') throw new ValidationError('links with a user name or password are not used');
  return { kind: 'url', url: url.toString() };
}

/** Synchronous check of one `source` (inbox path, img-id[#n], server:/path or http(s) link); throws why it can't be used. */
export function classifyReference(source: string, dirs: RefDirs): RefSource {
  const text = source.trim();
  if (/^https?:/i.test(text)) return link(text);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) throw new ValidationError(`${shortSource(text)} is not an http(s) link`);
  const id = IMAGE_ID_RE.exec(text);
  if (id?.[1] !== undefined) return earlierImage(id[1], Number(id[2] ?? '1'), dirs.imagesDir);
  const server = SERVER_RE.exec(text);
  if (server?.[1] !== undefined && server[1].length > 1) return serverFile(server[1], server[2] ?? '', dirs.hasServer);
  if (isAbsolute(text)) return inboxFile(text, dirs.inboxDir);
  throw new ValidationError(`${shortSource(text)}: use an inbox path, an image id (img-…), <server>:/path or an http(s) link`);
}

/** The picture's real type from its first bytes; only PNG, JPEG and WEBP go to GPT Image. */
export function sniffImage(data: Uint8Array): 'png' | 'jpg' | 'webp' {
  const ascii = (from: number, to: number): string => Buffer.from(data.subarray(from, to)).toString('latin1');
  if (data.length >= 8 && ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpg';
  if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 4) === 'GIF8') throw new Error('GIFs are not supported (use a PNG, JPEG or WEBP)');
  const head = ascii(0, 512).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) throw new Error('SVGs are not supported (use a PNG, JPEG or WEBP)');
  if (head.startsWith('<')) throw new Error('it is a web page or text, not a picture');
  throw new Error('it is not a PNG, JPEG or WEBP picture');
}

async function bytesOf(source: RefSource, fetchers: RefFetchers): Promise<Buffer> {
  if (source.kind === 'url') return fetchers.fetchUrl(source.url);
  if (source.kind === 'server') return fetchers.fetchServerFile(source.server, source.path);
  if ((await stat(source.path)).size > REFERENCE_MAX_BYTES) throw new Error('bigger than 20 MB');
  return readFile(source.path);
}

/** Copies/downloads one reference into the job folder as ref-<n>.<ext>; returns its absolute path. */
export async function materialiseReference(source: RefSource, n: number, jobDir: string, fetchers: RefFetchers): Promise<string> {
  const data = await bytesOf(source, fetchers);
  if (data.length > REFERENCE_MAX_BYTES) throw new Error('bigger than 20 MB');
  const ext = sniffImage(data);
  const path = join(jobDir, `ref-${n}.${ext}`);
  await writeFile(path, data, { mode: 0o640 });
  return path;
}
