import {
  isSelfHost, type NoticeDTO, type QuestionDTO, type RoomDTO, type SessionDTO, type SessionState, type ToolKind,
} from '@luady/shared';
import { hqName } from '../features/rooms/room-lookup.js';
import type { AppState } from './reducer.js';

export interface HostGroup {
  readonly host: string;
  readonly sessions: readonly SessionDTO[];
}

const STATE_ORDER: Readonly<Record<SessionState, number>> = {
  waiting_question: 0, waiting_permission: 0, error: 1, working: 2, starting: 3, idle: 4, ended: 5,
};

export function needsYou(session: Pick<SessionDTO, 'state'>): boolean {
  return session.state === 'waiting_question' || session.state === 'waiting_permission';
}

export function pendingCount(state: Pick<AppState, 'questions' | 'actions'>): number {
  return state.questions.length + state.actions.length;
}

/** The host as the label names it by default: the HQ name for the manager's own host, else its id. */
const plainHost = (host: string): string => (isSelfHost(host) ? hqName() : host);

/** "Meadow · meadow-hr": the host (through `hostLabel`, e.g. its room's name) and the session's name. */
export function sessionLabel(session: Pick<SessionDTO, 'host' | 'displayName'>, hostLabel: (host: string) => string = plainHost): string {
  return `${hostLabel(session.host)} · ${session.displayName}`;
}

/**
 * Hosts in the office's order: by their home room's slot (a server or local room), hosts without one after them by
 * id, the manager's own host last.
 */
export function hostOrder(rooms: readonly RoomDTO[] = []): (a: string, b: string) => number {
  const slot = new Map<string, number>();
  for (const room of rooms) {
    if (room.kind === 'project' || room.host === null) continue;
    const known = slot.get(room.host);
    if (known === undefined || room.position < known) slot.set(room.host, room.position);
  }
  const rank = (host: string): number => (isSelfHost(host) ? 2 : slot.has(host) ? 0 : 1);
  return (a, b) => rank(a) - rank(b) || (slot.get(a) ?? 0) - (slot.get(b) ?? 0) || a.localeCompare(b);
}

export function compareSessions(a: SessionDTO, b: SessionDTO): number {
  const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
  if (byState !== 0) return byState;
  const at = a.lastEventAt ?? '';
  const bt = b.lastEventAt ?? '';
  if (at !== bt) return at < bt ? 1 : -1;
  return a.displayName.localeCompare(b.displayName);
}

/** Sessions per host, hosts in the office's order (hostOrder), urgent sessions first; one pass over the sessions. */
export function groupByHost(
  sessions: readonly SessionDTO[], options: { readonly includeEnded: boolean; readonly rooms?: readonly RoomDTO[] },
): HostGroup[] {
  const byHost = new Map<string, SessionDTO[]>();
  for (const session of sessions) {
    if (!options.includeEnded && session.state === 'ended') continue;
    const list = byHost.get(session.host);
    // The arrays are this function's own until it returns: appending keeps the pass linear.
    if (list === undefined) byHost.set(session.host, [session]);
    else list.push(session);
  }
  return [...byHost.keys()].toSorted(hostOrder(options.rooms))
    .map((host) => ({ host, sessions: (byHost.get(host) ?? []).toSorted(compareSessions) }));
}

export function missions(sessions: readonly SessionDTO[]): readonly SessionDTO[] {
  return sessions.filter((session) => session.origin === 'manager').toSorted(compareSessions);
}

export function questionFor(questions: readonly QuestionDTO[], session: Pick<SessionDTO, 'pendingQid'>): QuestionDTO | undefined {
  return session.pendingQid ? questions.find((question) => question.qid === session.pendingQid) : undefined;
}

export function byOldest<T extends { readonly createdAt: string }>(items: readonly T[]): readonly T[] {
  return items.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Notices that still want the owner's eyes: unsettled, and not a question or permission (the answer card owns those). */
export function openNotices(notices: readonly NoticeDTO[]): readonly NoticeDTO[] {
  return notices.filter((notice) => notice.settledAt === null && notice.kind !== 'question' && notice.kind !== 'permission');
}

/** Luady chat message id → its open notice id: a chat view of that message can count as seeing the notice. */
export function chatNoticeIds(notices: readonly NoticeDTO[]): ReadonlyMap<string, string> {
  return new Map(openNotices(notices).flatMap((notice) => (notice.ref?.kind === 'manager' ? [[notice.ref.id, notice.id] as const] : [])));
}

/** sessionId → the tool kind it runs now (null between tools), for the map's bubbles. */
export function toolsOf(activity: AppState['activity']): Readonly<Record<string, ToolKind | null>> {
  return Object.fromEntries(Object.values(activity).map((item) => [item.sessionId, item.tool]));
}

/** The sessions the owner paused. */
export function pausedOf(activity: AppState['activity']): ReadonlySet<string> {
  return new Set(Object.values(activity).filter((item) => item.paused).map((item) => item.sessionId));
}
