import { copyFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';

const REASON_MAX = 300;
const IMAGE_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};
const AUTH_RE = /not logged in|401|unauthorized|log ?in|sign ?in|refresh token/i;
const LIMIT_RE = /usage_limit|rate limit|quota/i;

export const SIGN_IN_EXPIRED = 'ChatGPT sign-in for images has expired. Send /login codex to reconnect.';
export const LIMIT_REACHED = 'ChatGPT image limit reached — try again later.';
/** What the manager hears for any other failure: the image tool's own words stay in the hub log. */
export const NO_IMAGE = 'the image tool made no image; its own words are only in the hub log';

/**
 * A failed image job. `message` may quote the image tool for the owner; `forManager` is always one of the fixed lines
 * above, because the tool's text could carry anything it read on the hub machine.
 */
export class ImageJobError extends Error {
  constructor(message: string, readonly forManager: string) {
    super(message);
    this.name = 'ImageJobError';
  }
}

export interface CodexOutcome { threadId: string | null; lastMessage: string | null; errors: string[]; }

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null;
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

function errorOf(event: Json): string | null {
  if (event.type === 'error') return str(event.message);
  if (event.type === 'turn.failed' && isObject(event.error)) return str(event.error.message);
  if (event.type === 'item.completed' && isObject(event.item) && event.item.type === 'error') return str(event.item.message);
  return null;
}

/** `codex exec --json` output: the thread id, the model's last message and every error (non-JSON lines are skipped). */
export function parseCodexEvents(stdout: string): CodexOutcome {
  let threadId: string | null = null;
  let lastMessage: string | null = null;
  const errors: string[] = [];
  for (const line of stdout.split('\n')) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(event)) continue;
    if (event.type === 'thread.started') threadId = str(event.thread_id) ?? threadId;
    if (event.type === 'item.completed' && isObject(event.item) && event.item.type === 'agent_message') {
      lastMessage = str(event.item.text) ?? lastMessage;
    }
    const error = errorOf(event);
    if (error !== null) errors.push(error);
  }
  return { threadId, lastMessage, errors };
}

/** A sign-in or limit problem as its fixed line; null for any other failure. */
function knownFailure(outcome: CodexOutcome, stderr: string): string | null {
  const problems = [...outcome.errors, stderr].join('\n');
  if (AUTH_RE.test(problems)) return SIGN_IN_EXPIRED;
  if (LIMIT_RE.test(problems)) return LIMIT_REACHED;
  return outcome.threadId === null ? SIGN_IN_EXPIRED : null;
}

/** The manager's line on why no image came back: always a fixed one. */
export function managerFailureReason(outcome: CodexOutcome, stderr: string): string {
  return knownFailure(outcome, stderr) ?? NO_IMAGE;
}

/** One short line for the owner on why no image came back. */
export function failureReason(outcome: CodexOutcome, stderr: string): string {
  const known = knownFailure(outcome, stderr);
  if (known !== null) return known;
  const said = outcome.lastMessage !== null && !/^done\W*$/i.test(outcome.lastMessage) ? outcome.lastMessage : null;
  const text = said ?? outcome.errors[0] ?? 'no image came back';
  return text.replace(/\s+/g, ' ').slice(0, REASON_MAX);
}

export const imageMime = (file: string): string | undefined => IMAGE_EXT[extname(file).toLowerCase()];

/** Image files under dir (recursive, sorted); [] when it does not exist. `since` keeps only files modified at or after it. */
export async function listImages(dir: string, since?: number): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await listImages(path, since));
    else if (entry.isFile() && imageMime(entry.name) !== undefined) {
      if (since === undefined || (await stat(path)).mtimeMs >= since) found.push(path);
    }
  }
  return found.sort();
}

/** rename, or copy + unlink when the folders are on different devices. */
export async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await unlink(from);
  }
}
