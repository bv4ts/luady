import { LIMITS, isSelfHost, type BoardItemDTO, type SessionDTO } from '@luady/shared';
import { parseTime } from '../../../../lib/format.js';

/** The four lanes of the board, left to right. */
export const LANE_IDS = ['todo', 'running', 'needs', 'done'] as const;
export type LaneId = (typeof LANE_IDS)[number];

export const LANE_NAMES: Readonly<Record<LaneId, string>> = Object.freeze({
  todo: 'To do', running: 'Running', needs: 'Needs you', done: 'Done',
});

export type SessionsById = Readonly<Record<string, SessionDTO>>;

export interface Lanes {
  readonly todo: readonly BoardItemDTO[];
  readonly running: readonly BoardItemDTO[];
  readonly needs: readonly BoardItemDTO[];
  readonly done: readonly BoardItemDTO[];
  /** Open cards hidden until their snooze time. */
  readonly snoozed: number;
}

const DONE_KEEP_MS = LIMITS.boardDoneDays * 86_400_000;

export function sessionsById(sessions: readonly SessionDTO[]): SessionsById {
  return Object.freeze(Object.fromEntries(sessions.map((session) => [session.id, session])));
}

/** The session waits on the owner (a question or a permission) or failed: the card needs the owner. */
export function sessionNeedsOwner(session: SessionDTO | undefined): boolean {
  if (session === undefined) return false;
  if (session.state === 'waiting_question' || session.state === 'waiting_permission' || session.state === 'error') return true;
  return session.state === 'ended' && session.unexpectedEnd;
}

export function isSnoozed(card: BoardItemDTO, now: number): boolean {
  const until = parseTime(card.snoozeUntil);
  return until !== null && until > now;
}

/** Where a card sits; null = not on the board now (snoozed, or done more than 14 days ago). */
export function laneOf(card: BoardItemDTO, sessions: SessionsById, now: number): LaneId | null {
  switch (card.state) {
    case 'open': return isSnoozed(card, now) ? null : 'todo';
    case 'queued': return 'running';
    case 'running': return sessionNeedsOwner(card.sessionId === null ? undefined : sessions[card.sessionId]) ? 'needs' : 'running';
    case 'review': return 'needs';
    case 'done': {
      const at = parseTime(card.doneAt ?? card.updatedAt);
      return at !== null && now - at > DONE_KEEP_MS ? null : 'done';
    }
  }
}

const newer = (a: string | null, b: string | null): number => (b ?? '').localeCompare(a ?? '');

/** To do: "Today" cards first, then high priority, then newest. */
export function compareTodo(a: BoardItemDTO, b: BoardItemDTO): number {
  if (a.today !== b.today) return a.today ? -1 : 1;
  if (a.priority !== b.priority) return b.priority - a.priority;
  return newer(a.createdAt, b.createdAt) || b.id - a.id;
}

const byUpdate = (a: BoardItemDTO, b: BoardItemDTO): number => newer(a.updatedAt, b.updatedAt) || b.id - a.id;
const byDone = (a: BoardItemDTO, b: BoardItemDTO): number => newer(a.doneAt ?? a.updatedAt, b.doneAt ?? b.updatedAt) || b.id - a.id;

/** Every card in its lane and in lane order. */
export function buildLanes(cards: readonly BoardItemDTO[], sessions: SessionsById, now: number): Lanes {
  const placed: Record<LaneId, BoardItemDTO[]> = { todo: [], running: [], needs: [], done: [] };
  let snoozed = 0;
  for (const card of cards) {
    const lane = laneOf(card, sessions, now);
    if (lane !== null) placed[lane].push(card);
    else if (card.state === 'open') snoozed += 1;
  }
  return Object.freeze({
    todo: placed.todo.toSorted(compareTodo),
    running: placed.running.toSorted(byUpdate),
    needs: placed.needs.toSorted(byUpdate),
    done: placed.done.toSorted(byDone),
    snoozed,
  });
}

/** Cards the owner can tick for Run (to do and needs-you cards that no session holds now). */
export function canPick(card: BoardItemDTO): boolean {
  return card.state === 'open' || card.state === 'review';
}

const ACTIVE = new Set<SessionDTO['state']>(['working', 'starting', 'waiting_question', 'waiting_permission']);

/** "Also running": the owner's own live sessions that no card on the board is linked to. */
export function ownSessionsRunning(sessions: readonly SessionDTO[], cards: readonly BoardItemDTO[]): number {
  const linked = new Set(cards.filter((card) => card.state === 'running' || card.state === 'queued').map((card) => card.sessionId));
  return sessions.filter((session) => session.origin === 'owner' && !isSelfHost(session.host) && ACTIVE.has(session.state) && !linked.has(session.id)).length;
}
