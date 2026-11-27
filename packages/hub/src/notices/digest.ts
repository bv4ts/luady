import { clock12 } from '../core/time.js';
import { truncateChars } from '../notify/format.js';
import { settlesOnAnswer } from './policy.js';
import type { NoticeRow } from './repo.js';

/** More notices than this due at the same moment leave as a digest, not one by one. */
export const BACKLOG_AT_ONCE = 3;
/** Red questions and permissions that still go alone out of a backlog; any further ones are named in the digest. */
export const DIGEST_QUESTIONS_ALONE = 3;
export const DIGEST_LINES_MAX = 10;
/** One line per notice; 10 lines of this length keep the digest far under LIMITS.chatMessageMax. */
export const DIGEST_LINE_MAX = 110;
/** Older updates (not questions) are only counted. */
export const DIGEST_OLD_MS = 12 * 60 * 60_000;

export interface BacklogPlan {
  /** Sent one by one, three seconds apart. */
  readonly alone: readonly NoticeRow[];
  /** Everything else, in one message (empty when nothing goes into a digest). */
  readonly digest: readonly NoticeRow[];
}

/** Up to three due at once go alone; above that, at most three red questions alone and the rest as one digest. */
export function planBacklog(due: readonly NoticeRow[]): BacklogPlan {
  if (due.length <= BACKLOG_AT_ONCE) return { alone: due, digest: [] };
  const answerable = due.filter((row) => settlesOnAnswer(row.kind));
  const alone = answerable.slice(0, DIGEST_QUESTIONS_ALONE);
  return { alone, digest: due.filter((row) => !alone.includes(row)) };
}

/** First line of a notice, plain (no chat marks, which a cut could leave unbalanced), one space between words. */
function oneLine(text: string): string {
  const first = text.split('\n').find((line) => line.trim() !== '') ?? '';
  return truncateChars(first.replace(/[*_~`]/g, '').replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim(), DIGEST_LINE_MAX);
}

const isOld = (row: NoticeRow, now: Date): boolean =>
  !settlesOnAnswer(row.kind) && now.getTime() - Date.parse(row.createdAt) > DIGEST_OLD_MS;

/**
 * The owner's view of a backlog, as one chat message:
 * `📦 *6 updates* · 5:00 PM`, then `• 4:05 PM · <first line>` per notice (red questions first, at most 10 lines),
 * `+N more on the website`, and updates older than 12 hours only as a count.
 */
export function formatDigest(rows: readonly NoticeRow[], now: Date): string {
  const byTime = [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const listed = [...byTime.filter((row) => settlesOnAnswer(row.kind)), ...byTime.filter((row) => !settlesOnAnswer(row.kind) && !isOld(row, now))];
  const old = byTime.filter((row) => isOld(row, now)).length;
  const shown = listed.slice(0, DIGEST_LINES_MAX).map((row) => `• ${clock12(new Date(row.createdAt))} · ${oneLine(row.text)}`);
  const more = listed.length - shown.length;
  return [
    `📦 *${rows.length} updates* · ${clock12(now)}`,
    ...shown,
    ...(more > 0 ? [`+${more} more on the website`] : []),
    ...(old > 0 ? [`+${old} older ones (over 12 hours) on the website`] : []),
  ].join('\n');
}
