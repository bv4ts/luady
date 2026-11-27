import type { AccountDTO, BoardItemDTO, ServerDTO, SessionDTO } from '@luady/shared';
import { liveWindow } from './limits.js';

export type BadgeTone = 'info' | 'warn' | 'alert';

/** A number on a top-bar button or a fixture, with how loud it is. */
export interface Badge {
  readonly count: number;
  readonly tone: BadgeTone;
  /** Short words for a tooltip or a screen reader ("5 to do, 1 needs you"). */
  readonly words: string;
}

export interface BoardCounts {
  readonly todo: number;
  readonly needs: number;
}

/** A session state in which a running card needs the owner. */
const STUCK: ReadonlySet<string> = new Set(['waiting_question', 'waiting_permission', 'error']);

const snoozed = (card: BoardItemDTO, now: number): boolean => {
  const until = card.snoozeUntil === null ? Number.NaN : Date.parse(card.snoozeUntil);
  return Number.isFinite(until) && until > now;
};

/** To do: open and not snoozed. Needs you: in review, or running in a session that waits for the owner or failed. */
export function boardCounts(cards: readonly BoardItemDTO[], sessions: readonly SessionDTO[], now: number): BoardCounts {
  const stateOf = new Map(sessions.map((session) => [session.id, session.state]));
  const stuck = (card: BoardItemDTO): boolean =>
    (card.state === 'running' || card.state === 'queued') && card.sessionId !== null && STUCK.has(stateOf.get(card.sessionId) ?? '');
  return {
    todo: cards.filter((card) => card.state === 'open' && !snoozed(card, now)).length,
    needs: cards.filter((card) => card.state === 'review' || stuck(card)).length,
  };
}

/** The Board button's badge: to do plus needs you, red while anything needs the owner; null when both are zero. */
export function boardBadge(counts: BoardCounts): Badge | null {
  const count = counts.todo + counts.needs;
  if (count === 0) return null;
  const parts = [counts.todo > 0 ? `${counts.todo} to do` : null, counts.needs > 0 ? `${counts.needs} ${counts.needs === 1 ? 'needs' : 'need'} you` : null];
  return { count, tone: counts.needs > 0 ? 'alert' : 'info', words: parts.filter((part): part is string => part !== null).join(', ') };
}

/** An account this full (either window) or a server that is not online lights the TV's red dot. */
export const FLEET_ALERT_PCT = 95;

/** True when any server is offline or any Claude account has a running limit window at 95% or more. */
export function fleetAlert(
  servers: readonly Pick<ServerDTO, 'status'>[], accounts: readonly AccountDTO[], now: number,
): boolean {
  if (servers.some((server) => server.status === 'offline')) return true;
  return accounts.some((account) => account.limits.reported === 'yes'
    && [account.limits.fiveHour, account.limits.sevenDay].some((window) => (liveWindow(window, now)?.usedPct ?? 0) >= FLEET_ALERT_PCT));
}

const WEEK_MS = 7 * 24 * 60 * 60_000;

/** Cards done in the last 7 days: the wins board's count. */
export function winsThisWeek(cards: readonly BoardItemDTO[], now: number): number {
  return cards.filter((card) => {
    const at = card.state === 'done' && card.doneAt !== null ? Date.parse(card.doneAt) : Number.NaN;
    return Number.isFinite(at) && now - at <= WEEK_MS;
  }).length;
}

const DAY_MS = 24 * 60 * 60_000;

/** Schedules whose next run is within the next 24 hours. */
export function dueWithinDay(items: readonly { nextRunAt: string | null }[], now: number): number {
  return items.filter((item) => {
    const at = item.nextRunAt === null ? Number.NaN : Date.parse(item.nextRunAt);
    return Number.isFinite(at) && at >= now && at - now <= DAY_MS;
  }).length;
}
