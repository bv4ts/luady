import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { basename, extname, join, posix } from 'node:path';
import type { HostId } from '@luady/shared';
import type { ImageJobOptions, ImageJobs, ImageReference, Logger, OutboundChannel } from '../core/contracts.js';
import { RefusedError, ValidationError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { codexBin, codexEnv, npmEnv, spawnRun, type CodexRun } from './codex.js';
import { finalImagePrompt, imageInstruction, orderReferences } from './image-prompt.js';
import { classifyReference, materialiseReference, shortSource, type RefSource } from './image-refs.js';
import { flatText } from '../hosts/clean.js';
import { ImageJobError, failureReason, imageMime, listImages, managerFailureReason, moveFile, parseCodexEvents } from './image-result.js';
import { fetchImageUrl } from './safe-fetch.js';

export const IMAGE_TIMEOUT_MS = 6 * 60_000;
export const IMAGES_KEEP_MS = 14 * 24 * 60 * 60_000;
const UPDATE_TIMEOUT_MS = 5 * 60_000;
const MAX_PARALLEL = 2;
const MAX_REFERENCES = 5;
const OUTPUT_MAX = 2 * 1024 * 1024;
const PREVIEW_MAX = 120;
const REASON_MAX = 300;

export interface ImageGeneratorOptions {
  /** The hub user's home (media/codex.ts codexUserHome): codex in .local/bin, where the nightly update installs it. */
  home: string;
  /** The hub's own Codex home (media/codex.ts hubCodexHome): its ChatGPT sign-in and where Codex saves pictures. */
  codexDir: string;
  /** Where finished images live (inside the brain inbox, so `file_upload` can pass them on). */
  dir: string;
  /** The brain inbox: references must really be inside it. */
  inboxDir: string;
  log: Logger;
  outbound: OutboundChannel;
  /** An Event turn for the manager (deliver='manager' results and failures). */
  notifyLuady: (text: string) => Promise<void>;
  /** A file on one of the fleet's servers (via the fleet, like send_file). */
  fetchServerFile: (server: HostId, path: string) => Promise<Buffer>;
  /** Which hosts are servers of the fleet, for `<server>:/path` references. */
  hasServer?: (id: string) => boolean;
  /** An image link or a page's og:image; defaults to the SSRF-safe fetch. */
  fetchUrl?: (url: string) => Promise<Buffer>;
  run?: CodexRun;
  now?: () => number;
}

export interface ImageGenerator extends ImageJobs {
  active(): number;
  /** Nightly `npm install -g @openai/codex@latest` into ~/.local. */
  update(): Promise<string>;
}

export function codexImageArgs(jobDir: string, references: readonly string[]): string[] {
  return [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', jobDir,
    '-c', 'model_reasoning_effort="low"', ...references.flatMap((ref) => ['-i', ref]), '-',
  ];
}

interface JobRef extends ImageReference { from: RefSource; }
interface Job { id: string; prompt: string; references: JobRef[]; transparent: boolean; deliver: 'owner' | 'manager'; caption: string; }

export function createImageGenerator(opts: ImageGeneratorOptions): ImageGenerator {
  const run = opts.run ?? spawnRun;
  const now = opts.now ?? Date.now;
  const env = codexEnv(opts.home, opts.codexDir);
  const generated = posix.join(opts.codexDir, 'generated_images');
  const fetchers = { fetchServerFile: opts.fetchServerFile, fetchUrl: opts.fetchUrl ?? ((url: string) => fetchImageUrl(url)) };
  let running = 0;

  async function prune(): Promise<void> {
    const at = now();
    for (const name of await readdir(opts.dir).catch(() => [] as string[])) {
      const path = join(opts.dir, name);
      const info = await stat(path).catch(() => null);
      if (info !== null && at - info.mtimeMs > IMAGES_KEEP_MS) await rm(path, { recursive: true, force: true });
    }
  }

  /** Finds what codex saved (its home, else the job folder) and moves it into the job folder as image-1.png, … */
  async function collect(jobDir: string, threadId: string | null, startedAt: number): Promise<string[]> {
    const threadDir = threadId === null ? null : join(generated, threadId);
    let found = [...(threadDir === null ? [] : await listImages(threadDir)), ...await listImages(join(jobDir, 'generated_images'))];
    if (found.length === 0 && threadId === null) found = await listImages(generated, startedAt);
    const moved: string[] = [];
    for (const [index, file] of found.entries()) {
      const target = join(jobDir, `image-${index + 1}${extname(file).toLowerCase()}`);
      await moveFile(file, target);
      moved.push(target);
    }
    if (threadDir !== null) await rm(threadDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(join(jobDir, 'generated_images'), { recursive: true, force: true }).catch(() => undefined);
    return moved;
  }

  async function deliver(job: Job, images: readonly string[]): Promise<void> {
    if (job.deliver === 'manager') {
      const preview = job.prompt.slice(0, PREVIEW_MAX);
      await opts.notifyLuady(`🖼 Image ${job.id} is ready (nothing was sent to the owner): ${images.join(', ')} (request: ${preview})`);
      return;
    }
    for (const path of images) {
      const file = { kind: 'image' as const, mime: imageMime(path) ?? 'image/png', fileName: basename(path), caption: job.caption, path };
      // The chat when a channel takes files; otherwise the website keeps it for the owner.
      if (opts.outbound.sendFile !== undefined) await opts.outbound.sendFile(file);
      else if (opts.outbound.sendMediaPath !== undefined) await opts.outbound.sendMediaPath(file);
      else throw new Error('No way to send the owner a file');
    }
  }

  async function fail(job: Job, reason: string): Promise<void> {
    const text = job.deliver === 'manager' ? `⚠️ Image ${job.id} failed: ${reason}` : `⚠️ Couldn't make the image: ${reason}`;
    if (job.deliver === 'manager') await opts.notifyLuady(text).catch(() => undefined);
    else await opts.outbound.send(text, null).catch(() => null);
  }

  /** Every reference as ref-<n>.<ext> in the job folder (n = final order); the first failure ends the job. */
  async function materialise(job: Job, jobDir: string): Promise<string[]> {
    const paths: string[] = [];
    for (const [index, ref] of job.references.entries()) {
      try {
        paths.push(await materialiseReference(ref.from, index + 1, jobDir, fetchers));
      } catch (err) {
        const why = (err instanceof Error ? err.message : String(err)).slice(0, 200);
        throw new Error(`Couldn't use reference ${index + 1} (${shortSource(ref.source)}): ${why}`);
      }
    }
    return paths;
  }

  async function generate(job: Job, jobDir: string, startedAt: number): Promise<void> {
    const refPaths = await materialise(job, jobDir);
    const prompt = finalImagePrompt(job.prompt, job.references);
    const result = await run(codexBin(opts.home), codexImageArgs(jobDir, refPaths), {
      env, cwd: jobDir, input: imageInstruction({ prompt, refPaths, transparent: job.transparent }),
      timeoutMs: IMAGE_TIMEOUT_MS, maxOutput: OUTPUT_MAX,
    });
    await Promise.all(refPaths.map((path) => rm(path, { force: true })));
    const outcome = parseCodexEvents(result.stdout);
    const images = await collect(jobDir, outcome.threadId, startedAt);
    if (images.length === 0) {
      opts.log.warn({ id: job.id, code: result.code, outcome, stderr: result.stderr.slice(-2000) }, 'image generation failed');
      throw new ImageJobError(failureReason(outcome, result.stderr), managerFailureReason(outcome, result.stderr));
    }
    await deliver(job, images);
    opts.log.info({ id: job.id, images: images.length, references: refPaths.length, deliver: job.deliver }, 'image generated');
  }

  async function work(job: Job): Promise<void> {
    const jobDir = join(opts.dir, job.id);
    try {
      await mkdir(jobDir, { recursive: true, mode: 0o750 });
      await generate(job, jobDir, now());
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).slice(0, REASON_MAX);
      opts.log.warn({ id: job.id, reason }, 'image job failed');
      await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
      // The manager never reads the image tool's own words (a fixed line instead), and other reasons only on one line.
      const forManager = err instanceof ImageJobError ? err.forManager : flatText(reason, REASON_MAX);
      await fail(job, job.deliver === 'manager' ? forManager : reason);
    } finally {
      running -= 1;
    }
  }

  return {
    start(prompt, { references, transparent, deliver: target, caption }) {
      const text = prompt.trim();
      if (text === '') throw new ValidationError('image_generate needs a prompt');
      if (references.length > MAX_REFERENCES) throw new ValidationError(`At most ${MAX_REFERENCES} reference images`);
      const dirs = { inboxDir: opts.inboxDir, imagesDir: opts.dir, ...(opts.hasServer === undefined ? {} : { hasServer: opts.hasServer }) };
      const refs = orderReferences(references.map((ref) => ({ ...ref, from: classifyReference(ref.source, dirs) })));
      if (running >= MAX_PARALLEL) throw new RefusedError(`${MAX_PARALLEL} images are already being made; try again when one finishes`);
      const id = `img-${newId().slice(0, 8)}`;
      running += 1;
      void prune().catch(() => undefined);
      void work({ id, prompt: text, references: refs, transparent, deliver: target, caption });
      return { id, path: join(opts.dir, id, 'image-1.png') };
    },
    active: () => running,
    update: async () => {
      // npm from the PATH of npmEnv: the home's own .local/bin first (a Node linked there wins), else the system's.
      const args = ['install', '-g', '--prefix', posix.join(opts.home, '.local'), '@openai/codex@latest'];
      const result = await run('npm', args, { env: npmEnv(opts.home), cwd: opts.home, input: '', timeoutMs: UPDATE_TIMEOUT_MS, maxOutput: OUTPUT_MAX });
      if (result.code !== 0) throw new Error(`npm exited ${result.code}: ${result.stderr.trim().split('\n').pop() ?? ''}`);
      return result.stdout.trim().split('\n').pop() ?? '';
    },
  };
}
