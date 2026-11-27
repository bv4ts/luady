import type { NoticeDTO } from '@luady/shared';

/** At most this many notice toasts at a time. */
export const NOTICE_TOASTS_MAX = 3;
/** An ordinary toast stays at least this long after it first showed, even once it is acknowledged (3 seconds). */
export const TOAST_MIN_MS = 6_000;

/** Red: a question or permission. Its toast stays until dismissed or answered, and only an answer settles it. */
export const isRedNotice = (notice: NoticeDTO): boolean => notice.kind === 'question' || notice.kind === 'permission';

/** A direct answer to a chat message lives on the chat line; everything else Luady or the hub starts also toasts. */
const chatReply = (notice: NoticeDTO): boolean => notice.kind === 'reply' && notice.ref?.kind === 'manager';

export interface ToastInput {
  /** Newest first, as in the store. */
  readonly notices: readonly NoticeDTO[];
  /** Notices created before this (the page's load, with some slack) are listed, not toasted. */
  readonly since: number;
  /** Dismissed by the owner on this page. */
  readonly closed: ReadonlySet<string>;
  /** When each toast first showed. */
  readonly shownAt: ReadonlyMap<string, number>;
  readonly now: number;
}

function stillUp(notice: NoticeDTO, shownAt: number | undefined, now: number): boolean {
  if (isRedNotice(notice)) return notice.settledAt === null || notice.settledVia !== 'answer';
  if (notice.settledAt === null) return true;
  return shownAt !== undefined && now - shownAt < TOAST_MIN_MS;
}

/** The toasts to show now, newest on top, at most three. A settled one shows only if it was already on screen. */
export function toastList(input: ToastInput): readonly NoticeDTO[] {
  return input.notices
    .filter((n) => !chatReply(n) && !input.closed.has(n.id) && Date.parse(n.createdAt) >= input.since)
    .filter((n) => stillUp(n, input.shownAt.get(n.id), input.now))
    .slice(0, NOTICE_TOASTS_MAX);
}

/** When the next lingering toast must go (an ordinary one that is settled but has not shown 6 seconds yet). */
export function nextExpiry(toasts: readonly NoticeDTO[], shownAt: ReadonlyMap<string, number>): number | null {
  const ends = toasts
    .filter((n) => !isRedNotice(n) && n.settledAt !== null)
    .map((n) => (shownAt.get(n.id) ?? 0) + TOAST_MIN_MS);
  return ends.length === 0 ? null : Math.min(...ends);
}
