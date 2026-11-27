import { LIMITS, type TranscriptItemDTO } from '@luady/shared';
import type { CtlClient, TranscriptWindow } from '../core/contracts.js';
import { ValidationError } from '../core/errors.js';
import { clipText, oneLine, parseTranscriptChunk, type ParsedItem } from './parser.js';

export const CHUNK_BYTES = 262_144;
export const MAX_FETCHES = 4;
export const PAGE_LIMIT_MAX = 500;
export const CONDENSED_LAST_N_MAX = 100;
export const CONDENSED_ITEM_MAX = 800;
const CURSOR_RE = /^\d{1,15}$/;

export interface TranscriptPage {
  items: TranscriptItemDTO[];
  nextCursor: string | null;
}

/** Cursor = decimal byte offset of the oldest line already shown; null means the newest page. */
export function parseCursor(cursor: string | null): number | null {
  if (cursor === null) return null;
  if (!CURSOR_RE.test(cursor)) throw new ValidationError('invalid transcript cursor');
  return Number(cursor);
}

function dedupe(items: readonly ParsedItem[]): ParsedItem[] {
  const seen = new Set<string>();
  return items.filter((entry) => {
    if (seen.has(entry.item.uuid)) return false;
    seen.add(entry.item.uuid);
    return true;
  });
}

/** Keeps whole lines from the newest backwards until `limit` items; the cursor is the oldest kept line. */
function trimPage(collected: readonly ParsedItem[], limit: number, start: number): TranscriptPage {
  const starts = [...new Set(collected.map((entry) => entry.lineStart))];
  let keepFrom = starts.length;
  let count = 0;
  while (keepFrom > 0 && count < limit) {
    keepFrom -= 1;
    const lineStart = starts[keepFrom];
    count += collected.filter((entry) => entry.lineStart === lineStart).length;
  }
  const cut = keepFrom === 0 ? start : (starts[keepFrom] ?? start);
  const kept = collected.filter((entry) => entry.lineStart >= cut);
  return { items: kept.map((entry) => entry.item), nextCursor: cut > 0 ? String(cut) : null };
}

/** Newest page via `--tail` when cursor is null, else lines before the cursor via `--before/--max`. Items ascend. */
export async function readTranscriptPage(
  ctl: CtlClient,
  claudeSessionId: string,
  cursor: string | null,
  limit: number,
  chunkBytes: number = CHUNK_BYTES,
): Promise<TranscriptPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT_MAX) {
    throw new ValidationError(`limit must be an integer in 1..${PAGE_LIMIT_MAX}`);
  }
  const size = Math.min(Math.max(1, chunkBytes), LIMITS.transcriptChunkMax);
  let before = parseCursor(cursor);
  let collected: ParsedItem[] = [];
  let start = before ?? 0;
  for (let fetch = 0; fetch < MAX_FETCHES && before !== 0; fetch += 1) {
    const window: TranscriptWindow = before === null ? { tail: size } : { before, max: size };
    const chunk = await ctl.transcript(claudeSessionId, window);
    collected = [...parseTranscriptChunk(chunk.data, chunk.from).items, ...collected];
    const stalled = before !== null && chunk.from >= before;
    start = stalled ? 0 : chunk.from;
    if (stalled || collected.length >= limit) break;
    before = chunk.from;
  }
  return trimPage(dedupe(collected), limit, start);
}

/** `[role] text` lines for the last N items, for Luady's `session_read`. */
export async function condensedTranscript(ctl: CtlClient, claudeSessionId: string, lastN: number): Promise<string> {
  if (!Number.isInteger(lastN) || lastN < 1 || lastN > CONDENSED_LAST_N_MAX) {
    throw new ValidationError(`last_n must be an integer in 1..${CONDENSED_LAST_N_MAX}`);
  }
  const page = await readTranscriptPage(ctl, claudeSessionId, null, lastN);
  const items = page.items.slice(-lastN);
  if (items.length === 0) return '(no messages yet)';
  return items.map((entry) => `[${entry.role}] ${clipText(oneLine(entry.text), CONDENSED_ITEM_MAX)}`).join('\n');
}
