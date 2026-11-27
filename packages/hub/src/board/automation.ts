import { LIMITS, isSelfHost, type MissionDTO, type SessionDTO, managerName } from '@luady/shared';
import type { Clock, EventBus, HubEvents, LuadyService, Logger, SessionService } from '../core/contracts.js';
import type { BoardCore, CardChange } from './service.js';
import { parseCardReports, type CardReport } from './reports.js';
import type { CardStore } from './store.js';
import { clipUnits, oneLine } from './text.js';

/** What a card says when its session stopped before reporting it. */
export const STOPPED_TEXT = 'The session stopped without reporting this item.';
/** A queued card nobody took. */
export const NOT_PICKED_TEXT = `${managerName()} did not pick this up.`;
/** A queued card goes to review when no session took it this long after Luady was free to plan it. */
export const QUEUED_TIMEOUT_MS = 10 * 60_000;
export const BOARD_TICK_MS = 30_000;
/** Luady's mission_done summary as the result of the cards he checked (its start). */
export const LINKED_RESULT_MAX = 300;

/** The part of the mission service the board reads (missions/service.ts). */
export interface BoardMissions {
  isManaged(sessionId: string): boolean;
  views(): MissionDTO[];
  view(sessionId: string): MissionDTO | null;
}

export interface AutomationDeps {
  core: BoardCore;
  store: CardStore;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  sessions: Pick<SessionService, 'get'>;
  missions: Pick<BoardMissions, 'isManaged'>;
  luady: Pick<LuadyService, 'status' | 'signedOut'>;
}

export interface BoardAutomation {
  start(): void;
  stop(): void;
  /** One pass of the queued-card timeout; exposed for tests. */
  tick(): Promise<void>;
}

/**
 * The hub's bookkeeping without a model: a card per mission, cards ticked from the session's own reports, cards left
 * running when the work stops, and queued cards nobody took.
 */
export function createBoardAutomation(deps: AutomationDeps): BoardAutomation {
  const { core, store } = deps;
  let offs: Array<() => void> = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Since when Luady has been free (running, idle, nothing queued): the timeout counts only that time. */
  let freeSince: number | null = null;

  const now = (): number => deps.clock.now().getTime();

  function missionTitle(mission: MissionDTO): string {
    const title = oneLine(mission.title);
    return clipUnits(title === '' ? `Mission · ${mission.label}` : title, LIMITS.boardTitleMax);
  }

  async function onMissionUpdated(mission: MissionDTO): Promise<void> {
    if (!deps.missions.isManaged(mission.sessionId)) return;
    const working = store.ofSession(mission.sessionId, ['queued', 'running']);
    // Cards this mission already finished or sent for review stand for it: their session is not "a mission with no card".
    const handled = store.touchedSince(mission.sessionId, mission.openedAt);
    // One automatic card a session: one that waits in Needs you still stands for its mission.
    const hasAuto = store.ofSession(mission.sessionId, ['review']).some((card) => card.auto === 1);
    if (working.length === 0 && !handled && !hasAuto) {
      const session = deps.sessions.get(mission.sessionId);
      await core.add({
        title: missionTitle(mission), source: 'manager', sessionId: mission.sessionId,
        server: session !== undefined && !isSelfHost(session.host) ? session.host : null, project: session?.project ?? null,
      }, 'hub', { auto: true });
      return;
    }
    if (working.length === 0) return;
    const title = oneLine(mission.title);
    const renames: CardChange[] = working
      .filter((card) => card.auto === 1 && title !== '' && card.text !== missionTitle(mission))
      .map((card) => ({ id: card.id, patch: { title: missionTitle(mission) } }));
    if (renames.length > 0) await core.changeMany(renames, 'hub');
  }

  /** Gone = the hub no longer knows the session, or it has ended. An idle session with work in the background is not gone. */
  const gone = (sessionId: string): boolean => {
    const session = deps.sessions.get(sessionId);
    return session === undefined || session.state === 'ended';
  };

  const lastNote = (id: number): string | undefined => store.events(id).at(-1)?.text;

  /**
   * mission_done: Luady checked the work, so the cards are done with his summary. A mission closed any other way (the
   * idle timer, say) parks its cards for the owner only when the session itself is gone: a session that sits idle while
   * its background work runs still has the cards.
   */
  async function onMissionRemoved(e: HubEvents['mission.removed']): Promise<void> {
    const running = store.ofSession(e.sessionId, ['running']);
    if (running.length === 0) return;
    const checked = e.outcome === 'done' && e.summary !== null && e.summary.trim() !== '';
    if (!checked && !gone(e.sessionId)) return;
    const summary = oneLine(e.summary ?? '');
    const changes: CardChange[] = running.map((card) => ({
      id: card.id,
      patch: checked
        ? { state: 'done', result: clipUnits(summary, card.auto === 1 ? LIMITS.boardResultMax : LINKED_RESULT_MAX), note: `${managerName()} closed the mission as done.` }
        : { state: 'review', note: STOPPED_TEXT },
    }));
    await core.changeMany(changes, 'hub');
  }

  /** Only a session that is really gone parks its cards; a replayed event or one the session survived changes nothing. */
  async function onEnded(e: HubEvents['session.ended']): Promise<void> {
    if (e.replay || !gone(e.session.id)) return;
    const running = store.ofSession(e.session.id, ['running']);
    if (running.length === 0) return;
    await core.changeMany(running.map((card) => ({ id: card.id, patch: { state: 'review', note: STOPPED_TEXT } })), 'hub');
  }

  /** Cards parked as "stopped" although their session is alive (an older hub did that) go back to Running. */
  async function unpark(): Promise<void> {
    const parked = store.inState(['review']).filter((card) =>
      card.session_id !== null && !gone(card.session_id) && lastNote(card.id) === STOPPED_TEXT);
    if (parked.length > 0) {
      await core.changeMany(parked.map((card) => ({ id: card.id, patch: { state: 'running', note: 'The session is still there: back to Running.' } })), 'hub');
    }
    await dropDuplicates();
  }

  /** An older hub made a new automatic card each time it had parked the last one: keep the newest per session. */
  async function dropDuplicates(): Promise<void> {
    const autos = store.inState(['queued', 'running', 'review']).filter((card) => card.auto === 1 && card.session_id !== null);
    const newest = new Map<string, number>();
    for (const card of autos) newest.set(card.session_id ?? '', Math.max(newest.get(card.session_id ?? '') ?? 0, card.id));
    const extra = autos.filter((card) => newest.get(card.session_id ?? '') !== card.id).map((card) => card.id);
    if (extra.length > 0) await core.remove(extra);
  }

  function reportChange(report: CardReport, sessionId: string): CardChange | null {
    const card = store.get(report.id);
    // A session ticks only its own cards; a report never creates one.
    if (card === undefined || card.session_id !== sessionId || card.done === 1) return null;
    switch (report.verb) {
      case 'done':
        return { id: card.id, patch: { state: 'done', result: report.text === '' ? null : report.text, note: report.text || 'Reported done.' } };
      case 'blocked':
        return card.state === 'review'
          ? { id: card.id, patch: { note: report.text || 'Reported blocked.' } }
          : { id: card.id, patch: { state: 'review', note: report.text || 'Reported blocked.' } };
      case 'progress':
        // A card parked as "stopped" whose session reports again is plainly being worked on.
        if (card.state === 'review' && lastNote(card.id) === STOPPED_TEXT) return { id: card.id, patch: { state: 'running', note: report.text || 'Working again.' } };
        return report.text === '' ? null : { id: card.id, patch: { note: report.text, noteKind: 'report' } };
    }
  }

  async function onReport(e: HubEvents['session.report']): Promise<void> {
    const seen = new Set<number>();
    const changes = parseCardReports(e.text).flatMap((report) => {
      const change = reportChange(report, e.session.id);
      // One change per card and report: the first line about a card wins (a later done would re-plan stale state).
      if (change === null || seen.has(change.id)) return [];
      seen.add(change.id);
      return [change];
    });
    if (changes.length > 0) await core.changeMany(changes, 'hub');
  }

  function luadyFree(): boolean {
    const status = deps.luady.status();
    return deps.luady.signedOut?.() !== true && status.state === 'running' && status.queued === 0;
  }

  async function tick(): Promise<void> {
    const at = now();
    freeSince = luadyFree() ? freeSince ?? at : null;
    if (freeSince === null) return;
    const since = freeSince;
    const stale = store.waiting().filter((card) => {
      const queuedAt = card.queued_at === null ? Date.parse(card.updated_at ?? card.created_at) : Date.parse(card.queued_at);
      return at - Math.max(queuedAt, since) >= QUEUED_TIMEOUT_MS;
    });
    if (stale.length > 0) await core.changeMany(stale.map((card) => ({ id: card.id, patch: { state: 'review', note: NOT_PICKED_TEXT } })), 'hub');
  }

  function guarded<T>(event: string, fn: (payload: T) => Promise<void>): (payload: T) => void {
    return (payload) => {
      fn(payload).catch((err: unknown) => deps.log.error({ err, event }, 'board: handler failed'));
    };
  }

  return {
    start() {
      if (offs.length > 0) return;
      offs = [
        deps.bus.on('mission.updated', guarded('mission.updated', onMissionUpdated)),
        deps.bus.on('mission.removed', guarded('mission.removed', onMissionRemoved)),
        deps.bus.on('session.report', guarded('session.report', onReport)),
        deps.bus.on('session.ended', guarded('session.ended', onEnded)),
      ];
      unpark().catch((err: unknown) => deps.log.error({ err }, 'board: unpark failed'));
      timer = setInterval(() => {
        tick().catch((err: unknown) => deps.log.error({ err }, 'board: tick failed'));
      }, BOARD_TICK_MS);
    },
    stop() {
      for (const off of offs) off();
      offs = [];
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
