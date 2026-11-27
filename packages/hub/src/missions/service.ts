import { isSelfHost, type MissionDTO, type SessionDTO } from '@luady/shared';
import type {
  Clock, Db, EventBus, HubEvents, Logger, MissionTracker, OutboundChannel, SessionService, SettingsService,
} from '../core/contracts.js';
import { sessionLabel } from '../notify/format.js';
import { retireBoard } from './board-cleanup.js';
import { formatMissionDone, missionListLine, renderStatus, type MissionPhase, type MissionView } from './format.js';
import { missionDto, type MissionRow } from './dto.js';

/** A chat may let a sender edit a message for a while (15 minutes is the shortest such window); after that a fresh status message replaces the old one. */
export const MISSION_EDIT_WINDOW_MS = 14 * 60_000;
/** Luady reads every mission turn and closes missions with mission_done; this idle time is only the fallback. */
export const MISSION_SETTLE_MS = 60 * 60_000;
/** Shown when the fallback closes a mission Luady never summarised. */
export const FALLBACK_SUMMARY = 'Finished. Ask me for the details.';
export const MISSION_TICK_MS = 30_000;

export interface MissionDeps {
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  /** The status message (sent, edited in place, unpinned, revoked): written to the chat only while updates go there. */
  outbound: OutboundChannel;
  /** "Mission done": a result notice, on the website first while the owner is there. */
  results: OutboundChannel;
  settings: SettingsService;
  sessions: SessionService;
}

/**
 * isManaged: Luady started or sent work to this session, so its mission waits for mission_done and Luady hears about
 * each turn. finish: closes the status and sends the "mission done" message (false when none was open; still sent).
 */
export interface MissionService extends MissionTracker {
  /** GET /api/missions: every open mission as the website shows it. */
  views(): MissionDTO[];
  /** One open mission, or null. */
  view(sessionId: string): MissionDTO | null;
  start(): void;
  stop(): void;
  /** One settle pass; exposed for tests. */
  tick(): Promise<void>;
}

type Row = MissionRow;

function view(row: Row): MissionView {
  return { label: row.label, title: row.title, phase: row.phase, turns: row.turns, openedAt: row.opened_at, note: row.note, lastText: row.last_text };
}

/**
 * Edited-in-place status per mission: one message while it runs, one "done" at the end.
 * The status is written to the chat only while updates go there (the website shows missions live otherwise); "done" is
 * a result notice. Statuses aren't pinned. The old pinned board message is retired once (board-cleanup.ts).
 */
export function createMissionService(deps: MissionDeps): MissionService {
  const db = deps.db;
  const getRow = db.prepare<[string], Row>('SELECT * FROM missions WHERE session_id = ?');
  const allRows = db.prepare<[], Row>('SELECT * FROM missions ORDER BY opened_at');
  const insert = db.prepare<[string, string, string, string, number, string]>(
    "INSERT OR IGNORE INTO missions (session_id, label, title, phase, turns, managed, opened_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
  );
  const remove = db.prepare<[string]>('DELETE FROM missions WHERE session_id = ?');
  const setMessage = db.prepare<[string | null, string | null, string]>('UPDATE missions SET chat_msg_id = ?, sent_at = ? WHERE session_id = ?');
  const setPhase = db.prepare<[string, string | null, string]>('UPDATE missions SET phase = ?, idle_since = ? WHERE session_id = ?');
  const setTurn = db.prepare<[string, string, string]>(
    "UPDATE missions SET turns = turns + 1, last_text = ?, phase = 'idle', idle_since = ? WHERE session_id = ?",
  );
  const setNote = db.prepare<[string, string]>('UPDATE missions SET note = ? WHERE session_id = ?');
  const setManaged = db.prepare<[string]>('UPDATE missions SET managed = 1 WHERE session_id = ?');
  const remoteTurn = db.prepare<[string], { turn_remote: number }>('SELECT turn_remote FROM sessions WHERE id = ?');
  const setTitle = db.prepare<[string, string]>('UPDATE missions SET title = ? WHERE session_id = ?');
  const managedSoon = new Set<string>();
  const chains = new Map<string, Promise<void>>();
  let unsubscribers: Array<() => void> = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let boardRetired = false;

  const now = (): Date => deps.clock.now();
  const muted = (): boolean => {
    const until = deps.settings.get().mute_until;
    return until !== null && Date.parse(until) > now().getTime();
  };

  /** Per-mission serialisation, so edits and replacements never race. */
  function serial(sessionId: string, work: () => Promise<void>): Promise<void> {
    const next = (chains.get(sessionId) ?? Promise.resolve()).then(work).catch((err: unknown) => {
      deps.log.warn({ err, sessionId }, 'missions: status update failed');
    });
    chains.set(sessionId, next);
    return next;
  }

  async function sendFresh(row: Row, text: string): Promise<void> {
    const msgId = await deps.outbound.send(text, { kind: 'session', refId: row.session_id });
    if (msgId === null) return;
    setMessage.run(msgId, now().toISOString(), row.session_id);
    if (row.chat_msg_id !== null) {
      deps.outbound.pin?.(row.chat_msg_id, false);
      deps.outbound.revoke?.(row.chat_msg_id);
    }
  }

  async function editable(row: Row, text: string): Promise<boolean> {
    if (row.chat_msg_id === null || row.sent_at === null || deps.outbound.edit === undefined) return false;
    if (now().getTime() - Date.parse(row.sent_at) >= MISSION_EDIT_WINDOW_MS) return false;
    return deps.outbound.edit(row.chat_msg_id, text);
  }

  /** The website hears every change of an open mission at once; the chat follows through the serial chain. */
  function announce(sessionId: string): void {
    const row = getRow.get(sessionId);
    if (row !== undefined) deps.bus.emit('mission.updated', missionDto(row));
  }

  function push(sessionId: string): Promise<void> {
    announce(sessionId);
    return serial(sessionId, async () => {
      const row = getRow.get(sessionId);
      if (row === undefined) return;
      const text = renderStatus(view(row), now());
      if (!(await editable(row, text))) await sendFresh(row, text);
    });
  }

  function shouldTrack(session: SessionDTO): boolean {
    if (session.origin === 'manager' || managedSoon.has(session.id)) return true;
    if (remoteTurn.get(session.id)?.turn_remote === 1) return true;
    return deps.settings.get().away;
  }

  function open(session: SessionDTO, phase: MissionPhase): void {
    const managed = session.origin === 'manager' || managedSoon.delete(session.id) ? 1 : 0;
    insert.run(session.id, sessionLabel(session), '', phase, managed, now().toISOString());
  }

  async function close(sessionId: string, phase: 'done' | 'ended', summary: string | null): Promise<void> {
    await serial(sessionId, async () => {
      const row = getRow.get(sessionId);
      if (row === undefined) return;
      const final = { ...row, phase };
      remove.run(sessionId);
      // Luady's mission_done carries a summary; the idle timer closes with none (the board tells the two apart).
      deps.bus.emit('mission.removed', { sessionId, outcome: phase, summary });
      const text = renderStatus(view(final), now());
      const edited = await editable(final, text);
      if (row.chat_msg_id !== null) {
        deps.outbound.pin?.(row.chat_msg_id, false);
        if (!edited && phase === 'done') deps.outbound.revoke?.(row.chat_msg_id);
      }
      if (phase === 'done' && !muted()) {
        const body = summary ?? FALLBACK_SUMMARY;
        await deps.results.send(formatMissionDone(view(row), body, now()), { kind: 'session', refId: sessionId });
      }
    });
  }

  async function onSessionUpdated(session: SessionDTO): Promise<void> {
    if (session.origin === 'system' || isSelfHost(session.host)) return;
    const row = getRow.get(session.id);
    if (session.state === 'ended') {
      if (row !== undefined) await close(session.id, 'ended', null);
      return;
    }
    const waiting = session.state === 'waiting_question' || session.state === 'waiting_permission';
    const phase: MissionPhase | null = session.state === 'working' ? 'working' : waiting ? 'waiting' : null;
    if (phase === null) return;
    if (row === undefined) {
      if (phase !== 'working' || !shouldTrack(session)) return;
      open(session, phase);
    } else if (row.phase === phase) {
      return;
    } else {
      setPhase.run(phase, null, session.id);
    }
    await push(session.id);
  }

  async function onTurnFinished(e: HubEvents['turn.finished']): Promise<void> {
    if (e.replay || getRow.get(e.session.id) === undefined) return;
    setTurn.run(e.lastMessage.trim(), now().toISOString(), e.session.id);
    await push(e.session.id);
  }

  async function tick(): Promise<void> {
    const at = now().getTime();
    for (const row of allRows.all()) {
      if (row.phase !== 'idle' || row.idle_since === null) continue;
      if (at - Date.parse(row.idle_since) >= MISSION_SETTLE_MS) await close(row.session_id, 'done', null);
    }
  }

  function guarded<T>(event: string, fn: (payload: T) => Promise<void>): (payload: T) => void {
    return (payload) => {
      fn(payload).catch((err: unknown) => deps.log.error({ err, event }, 'missions: handler failed'));
    };
  }

  return {
    start() {
      if (unsubscribers.length > 0) return;
      unsubscribers = [
        deps.bus.on('session.updated', guarded('session.updated', onSessionUpdated)),
        deps.bus.on('turn.finished', guarded('turn.finished', onTurnFinished)),
      ];
      timer = setInterval(() => {
        tick().catch((err: unknown) => deps.log.error({ err }, 'missions: tick failed'));
        if (!boardRetired) boardRetired = retireBoard({ db: deps.db, outbound: deps.outbound, log: deps.log });
      }, MISSION_TICK_MS);
    },
    stop() {
      for (const off of unsubscribers) off();
      unsubscribers = [];
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    isOpen: (sessionId) => getRow.get(sessionId) !== undefined,
    isManaged: (sessionId) => managedSoon.has(sessionId) || getRow.get(sessionId) !== undefined,
    manage(sessionId) {
      if (getRow.get(sessionId) === undefined) managedSoon.add(sessionId);
      else setManaged.run(sessionId);
    },
    list: () => allRows.all().map((row) => missionListLine(view(row), now())),
    views: () => allRows.all().map(missionDto),
    view(sessionId) {
      const row = getRow.get(sessionId);
      return row === undefined ? null : missionDto(row);
    },
    async note(session, note, title) {
      if (getRow.get(session.id) === undefined) {
        managedSoon.add(session.id);
        open(session, session.state === 'working' ? 'working' : 'idle');
      }
      if (note.trim() !== '') setNote.run(note.trim(), session.id);
      if (title !== undefined && title.trim() !== '') setTitle.run(title.trim(), session.id);
      await push(session.id);
    },
    async finish(session, summary) {
      if (getRow.get(session.id) !== undefined) {
        await close(session.id, 'done', summary);
        return true;
      }
      deps.bus.emit('mission.removed', { sessionId: session.id, outcome: 'done', summary });
      const stub: MissionView = {
        label: sessionLabel(session), title: '', phase: 'done', turns: 0, openedAt: now().toISOString(), note: null, lastText: null,
      };
      if (!muted()) await deps.results.send(formatMissionDone(stub, summary, now()), { kind: 'session', refId: session.id });
      return false;
    },
    tick,
  };
}
