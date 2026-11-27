import type { QuestionDTO } from '@luady/shared';

/** A session that waits for the owner, and the question it waits on (if the hub told us). */
export interface Waiting { readonly id: string; readonly qid: string | null }

/** Epoch ms of a question, or undefined when its createdAt cannot be read. */
const askedMs = (q: QuestionDTO): number | undefined => {
  const t = Date.parse(q.createdAt);
  return Number.isFinite(t) ? t : undefined;
};

/**
 * Readable ask times per waiting session: of its pending questions, plus the one its qid names. One pass over the
 * questions (linear, never waiting × questions).
 */
const askTimes = (waiting: readonly Waiting[], questions: readonly QuestionDTO[]): ReadonlyMap<string, readonly number[]> => {
  const owners = new Map(waiting.flatMap((w) => (w.qid === null ? [] : [[w.qid, w.id] as const])));
  const times = new Map<string, number[]>(waiting.map((w) => [w.id, []]));
  questions.forEach((q) => {
    const at = askedMs(q);
    if (at === undefined) return;
    const ids = new Set([...(q.state === 'pending' ? [q.sessionId] : []), ...(owners.has(q.qid) ? [owners.get(q.qid) ?? q.sessionId] : [])]);
    ids.forEach((id) => times.get(id)?.push(at));
  });
  return times;
};

/**
 * Ids of the waiting sessions, the one asked first leading: the oldest readable time among its pending questions and
 * the question its qid names decides. No readable time sorts last; ties go by id.
 */
export function orderByQuestionAge(waiting: readonly Waiting[], questions: readonly QuestionDTO[]): readonly string[] {
  const times = askTimes(waiting, questions);
  const firstAsked = (id: string): number => (times.get(id) ?? []).reduce((first, at) => Math.min(first, at), Number.POSITIVE_INFINITY);
  return Object.freeze(
    waiting
      .map((w) => ({ id: w.id, at: firstAsked(w.id) }))
      .toSorted((x, y) => (x.at === y.at ? (x.id < y.id ? -1 : 1) : x.at < y.at ? -1 : 1))
      .map((x) => x.id),
  );
}
