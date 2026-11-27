import { randomUUID } from 'node:crypto';
import { constants, readdirSync, readFileSync, rmSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { outboxDir } from '../config/defaults.js';
import { FILE_MODE, ensureDir, writeFileAtomic } from '../config/files.js';
import type { Clock, HubConfig, Logger } from '../core/contracts.js';
import { RefusedError } from '../core/errors.js';
import { OUTBOX_FILE_MAX_BYTES, OUTBOX_TOTAL_MAX_BYTES, OUTBOX_TOTAL_MAX_FILES, describeBytes } from './budgets.js';
import { FileTooBigError, copyCapped, sameFile, type FileIdentity } from './paths.js';

/** A file for the owner, kept on the website while no chat channel is up, for 30 days. */
export const OUTBOX_KEEP_MS = 30 * 24 * 60 * 60_000;
/** The outbox's limits (channels/budgets.ts); tests pass smaller ones. */
export interface OutboxLimits { readonly fileBytes: number; readonly totalBytes: number; readonly totalFiles: number }
export const OUTBOX_LIMITS: OutboxLimits = { fileBytes: OUTBOX_FILE_MAX_BYTES, totalBytes: OUTBOX_TOTAL_MAX_BYTES, totalFiles: OUTBOX_TOTAL_MAX_FILES };
export const OUTBOX_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME_MAX = 255;
const MIME_RE = /^[a-z]+\/[a-z0-9.+-]{1,100}$/;
const FALLBACK_MIME = 'application/octet-stream';

export interface OutboxFile {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly createdAt: string;
  /** The website notice that carries it. */
  readonly noticeId: string | null;
}

export type OutboxInput =
  | { readonly name: string; readonly mime: string; readonly data: Buffer }
  /**
   * A file on this machine (an image the hub made, a real path inside an add-on's files folder): copied in. With
   * `identity` (from the path check) the opened file must still be that file.
   */
  | { readonly name: string; readonly mime: string; readonly fromPath: string; readonly identity?: FileIdentity };

export interface Outbox {
  put(input: OutboxInput): Promise<OutboxFile>;
  attach(fileId: string, noticeId: string): void;
  get(id: string): OutboxFile | null;
  byNotice(noticeId: string): OutboxFile | null;
  /** Where the bytes are, for the download route; null when the id is unknown or swept. */
  pathOf(id: string): string | null;
  /** Removes what is older than 30 days (and anything left without its record); returns how many files went. */
  sweep(): number;
}

const MetaSchema = z.strictObject({
  id: z.string().regex(OUTBOX_ID_RE), name: z.string().min(1).max(NAME_MAX), mime: z.string().max(200), size: z.number().int().min(0),
  createdAt: z.string(), noticeId: z.string().max(64).nullable(),
});

/** A file name safe to show and to put in a download header: no folders, no control characters, at most 255. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, NAME_MAX);
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean;
}

/** The type the download is served as: a plain `type/subtype`, else octet-stream. */
export function safeMime(mime: string): string {
  const lower = mime.trim().toLowerCase();
  return MIME_RE.test(lower) ? lower : FALLBACK_MIME;
}

export function createOutbox(deps: { config: Pick<HubConfig, 'dataDir'>; clock: Clock; log: Logger; limits?: OutboxLimits }): Outbox {
  const limits = deps.limits ?? OUTBOX_LIMITS;
  const dir = outboxDir(deps.config);
  const metaPath = (id: string): string => join(dir, `${id}.json`);
  const dataPath = (id: string): string => join(dir, id);
  let index: ReadonlyMap<string, OutboxFile> = load();

  function load(): ReadonlyMap<string, OutboxFile> {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return new Map();
    }
    const found = new Map<string, OutboxFile>();
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        const meta = MetaSchema.parse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
        found.set(meta.id, meta);
      } catch {
        deps.log.warn({ file: name }, 'outbox: skipped an unreadable record');
      }
    }
    return found;
  }

  function save(file: OutboxFile): void {
    writeFileAtomic(metaPath(file.id), JSON.stringify(file), FILE_MODE);
    index = new Map([...index, [file.id, file]]);
  }

  const tooBig = (): RefusedError => new RefusedError(`The file is too big for the website (at most ${describeBytes(limits.fileBytes)}).`);

  /** Refused, never making room: the oldest files stay until the 30-day sweep. */
  /** Space held by copies still running, so two at once cannot both pass the quota. */
  const reserved = new Map<string, number>();

  function checkQuota(id: string, bytes: number): void {
    const files = [...index.values()];
    const used = files.reduce((sum, file) => sum + file.size, 0) + [...reserved.values()].reduce((sum, n) => sum + n, 0);
    if (files.length + reserved.size >= limits.totalFiles) {
      throw new RefusedError(`The website already keeps ${limits.totalFiles} files for the owner; it takes more once older ones expire.`);
    }
    if (used + bytes > limits.totalBytes) {
      throw new RefusedError(`The website's file store is full (${describeBytes(limits.totalBytes)}); it takes more once older files expire.`);
    }
    reserved.set(id, bytes);
  }

  async function write(id: string, input: OutboxInput): Promise<number> {
    const target = dataPath(id);
    if ('data' in input) {
      if (input.data.length > limits.fileBytes) throw tooBig();
      checkQuota(id, input.data.length);
      const handle = await open(target, 'wx', FILE_MODE);
      try {
        await handle.writeFile(input.data);
      } finally {
        await handle.close();
      }
      return input.data.length;
    }
    // Opened without following a link: the path was checked as a real path, and a link swapped in since is refused;
    // with an identity from that check, the opened file must still be the checked one.
    const source = await open(input.fromPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await source.stat();
      if (!info.isFile()) throw new RefusedError('Only a plain file can be kept for the website.');
      if (input.identity !== undefined && !sameFile(input.identity, { dev: info.dev, ino: info.ino })) {
        throw new RefusedError('The file changed after it was checked.');
      }
      if (info.size > limits.fileBytes) throw tooBig();
      checkQuota(id, info.size);
    } catch (err) {
      await source.close();
      throw err;
    }
    try {
      return await copyCapped(source, target, limits.fileBytes, FILE_MODE);
    } catch (err) {
      throw err instanceof FileTooBigError ? tooBig() : err;
    }
  }

  return {
    async put(input) {
      ensureDir(dir);
      const id = randomUUID();
      try {
        const size = await write(id, input);
        const file: OutboxFile = {
          id, name: safeFileName(input.name), mime: safeMime(input.mime), size, createdAt: deps.clock.now().toISOString(), noticeId: null,
        };
        save(file);
        deps.log.info({ file: id, size }, 'outbox: kept a file for the website');
        return file;
      } catch (err) {
        await rm(dataPath(id), { force: true }).catch(() => undefined);
        throw err;
      } finally {
        reserved.delete(id);
      }
    },
    attach(fileId, noticeId) {
      const file = index.get(fileId);
      if (file !== undefined) save({ ...file, noticeId });
    },
    get: (id) => (OUTBOX_ID_RE.test(id) ? index.get(id) ?? null : null),
    byNotice: (noticeId) => [...index.values()].find((file) => file.noticeId === noticeId) ?? null,
    pathOf: (id) => (OUTBOX_ID_RE.test(id) && index.has(id) ? dataPath(id) : null),
    sweep() {
      const cut = deps.clock.now().getTime() - OUTBOX_KEEP_MS;
      let removed = 0;
      for (const file of index.values()) {
        if (Date.parse(file.createdAt) >= cut) continue;
        rmSync(dataPath(file.id), { force: true });
        rmSync(metaPath(file.id), { force: true });
        removed += 1;
      }
      index = new Map([...index].filter(([, file]) => Date.parse(file.createdAt) >= cut));
      // Bytes left without a record (a crash between the two writes) go too.
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        names = [];
      }
      for (const name of names) {
        if (OUTBOX_ID_RE.test(name) && !index.has(name)) {
          rmSync(join(dir, name), { force: true });
          removed += 1;
        }
      }
      if (removed > 0) deps.log.info({ removed }, 'outbox: removed files older than 30 days');
      return removed;
    },
  };
}
