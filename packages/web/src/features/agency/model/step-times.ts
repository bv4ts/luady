import type { AppState } from '../../../state/reducer.js';

/**
 * sessionId → epoch ms of its last tool step, for the office's silence check ("?" after 10 quiet minutes).
 * Sessions without a (readable) step time are left out: no entry means no warning, so an older hub never shows "?".
 */
export function stepTimesOf(activity: AppState['activity']): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.values(activity).flatMap((item) => {
    const at = item.lastStepAt === null ? Number.NaN : Date.parse(item.lastStepAt);
    return Number.isFinite(at) ? [[item.sessionId, at] as const] : [];
  }));
}

/** sessionId → helpers running now (only sessions that have any). */
export function helpersOf(activity: AppState['activity']): Readonly<Record<string, number>> {
  return Object.fromEntries(Object.values(activity).filter((item) => item.helpers > 0).map((item) => [item.sessionId, item.helpers]));
}

/** sessionId → context use in percent, null without a reading. */
export function contextOf(activity: AppState['activity']): Readonly<Record<string, number | null>> {
  return Object.fromEntries(Object.values(activity).map((item) => [item.sessionId, item.contextPct]));
}
