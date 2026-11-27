import { LIMITS, type NoticeDTO, type SessionActivityDTO, type SessionDetailDTO, type StepDTO, type WsServerMessage } from '@luady/shared';

export type ActivityMap = Readonly<Record<string, SessionActivityDTO>>;
type StepsMessage = Extract<WsServerMessage, { type: 'steps.appended' }>;

/** The notices the website keeps. */
export const NOTICES_KEPT = 100;

const sameHelperTypes = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((type, i) => type === b[i]));

/** The optional fields (title, helper types, turn start) count too, so a new step title reaches the activity list. */
const sameActivity = (a: SessionActivityDTO, b: SessionActivityDTO): boolean =>
  a.sessionId === b.sessionId && a.tool === b.tool && a.paused === b.paused && a.helpers === b.helpers
  && a.contextPct === b.contextPct && a.lastStepAt === b.lastStepAt
  && a.title === b.title && a.turnStartedAt === b.turnStartedAt && sameHelperTypes(a.helperTypes, b.helperTypes);

/** `activity.updated`: the changed sessions replace theirs; every other entry is kept by reference. */
export function mergeActivity(prev: ActivityMap, items: readonly SessionActivityDTO[]): ActivityMap {
  const changed = items.filter((item) => {
    const known = Object.hasOwn(prev, item.sessionId) ? prev[item.sessionId] : undefined;
    return known === undefined || !sameActivity(known, item);
  });
  if (changed.length === 0) return prev;
  return Object.freeze({ ...prev, ...Object.fromEntries(changed.map((item) => [item.sessionId, item])) });
}

/** `GET /api/activity`: the whole map; sessions missing from it are gone, equal entries keep their object. */
export function loadActivity(prev: ActivityMap, items: readonly SessionActivityDTO[]): ActivityMap {
  return Object.freeze(Object.fromEntries(items.map((item) => {
    const known = Object.hasOwn(prev, item.sessionId) ? prev[item.sessionId] : undefined;
    return [item.sessionId, known !== undefined && sameActivity(known, item) ? known : item];
  })));
}

/** The newest open main-thread step, else the newest open step (a helper's), else null. Same rule as the hub. */
export function currentOf(steps: readonly StepDTO[]): StepDTO | null {
  const open = steps.filter((step) => step.endedAt === null);
  return open.findLast((step) => step.agentId === null) ?? open.at(-1) ?? null;
}

/** Each step replaces the one with the same id or is appended; the newest LIMITS.stepRingSize are kept. */
function upsertSteps(steps: readonly StepDTO[], incoming: readonly StepDTO[]): readonly StepDTO[] {
  const merged = incoming.reduce<readonly StepDTO[]>((list, step) => {
    const at = list.findIndex((known) => known.id === step.id);
    return at === -1 ? [...list, step] : list.map((known, i) => (i === at ? step : known));
  }, steps);
  return merged.slice(-LIMITS.stepRingSize);
}

/** A `steps.appended` message applied to an open agent view. `todos`/`helpers` null mean unchanged. */
export function applySteps(detail: SessionDetailDTO, message: StepsMessage): SessionDetailDTO {
  const steps = upsertSteps(detail.steps, message.steps);
  return {
    ...detail,
    steps: [...steps],
    todos: message.todos === null ? detail.todos : [...message.todos],
    helpers: message.helpers === null ? detail.helpers : [...message.helpers],
    current: currentOf(steps),
  };
}

/** What an agent view holds before its detail has loaded: nothing yet, so steps from the socket can land. */
export function emptyDetail(sessionId: string): SessionDetailDTO {
  return { sessionId, current: null, steps: [], todos: [], helpers: [], meters: null, paused: false, pauseHit: false };
}

/** The loaded detail wins; steps that reached the socket first and are not in it are kept after its own, once. */
export function mergeDetail(prev: SessionDetailDTO | undefined, loaded: SessionDetailDTO): SessionDetailDTO {
  if (prev === undefined) return loaded;
  const known = new Set(loaded.steps.map((step) => step.id));
  const extra = prev.steps.filter((step) => !known.has(step.id));
  if (extra.length === 0) return loaded;
  const steps = upsertSteps(loaded.steps, extra);
  return { ...loaded, steps: [...steps], current: currentOf(steps) };
}

/** The map's pause flag is the newer one: an open view follows it (a resumed agent is no longer stopped). */
export function followPause(detail: SessionDetailDTO, activity: SessionActivityDTO | undefined): SessionDetailDTO {
  if (activity === undefined || activity.paused === detail.paused) return detail;
  return { ...detail, paused: activity.paused, pauseHit: activity.paused ? detail.pauseHit : false };
}

/** Over the cap: drop the oldest settled notice, else the oldest one. The list is newest first. */
function capNotices(list: readonly NoticeDTO[]): readonly NoticeDTO[] {
  if (list.length <= NOTICES_KEPT) return list;
  const settled = list.findLastIndex((notice) => notice.settledAt !== null);
  const drop = settled === -1 ? list.length - 1 : settled;
  return capNotices(list.filter((_, i) => i !== drop));
}

/** `notice.created` / `notice.updated`: replace by id where it is, or put it first. */
export function upsertNotice(list: readonly NoticeDTO[], notice: NoticeDTO): readonly NoticeDTO[] {
  const at = list.findIndex((known) => known.id === notice.id);
  if (at !== -1) return list.map((known, i) => (i === at ? notice : known));
  return capNotices([notice, ...list]);
}

/** `GET /api/notices`: newest first, capped. */
export function loadNotices(items: readonly NoticeDTO[]): readonly NoticeDTO[] {
  return capNotices(items.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt)));
}
