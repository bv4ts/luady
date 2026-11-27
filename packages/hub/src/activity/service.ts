import type {
  ActivitySpoolEvent, HostId, RateWindowDTO, RateWindowWire, SessionActivityDTO, SessionDTO, SessionDetailDTO, SessionState,
} from '@luady/shared';
import type { Clock, EventBus, Logger } from '../core/contracts.js';
import { isoNow } from '../core/time.js';
import type { ActivitySink } from '../ingest/ingester.js';
import { sessionIdForEvent } from '../sessions/naming.js';
import { normalizeTs } from '../sessions/registry.js';
import { createMapCoalescer } from './coalesce.js';
import type { PauseService } from './pause.js';
import { applyActivity, emptyActivity, endTurn, toDetail, toMapView, type SessionActivity } from './store.js';
import { createStepStream } from './stream.js';

export const ACTIVITY_BROADCAST_MS = 1_000;
export const STEPS_FLUSH_MS = 250;

export interface ActivityService extends ActivitySink {
  start(): void;
  stop(): void;
  snapshot(): SessionActivityDTO[];
  detail(sessionId: string): SessionDetailDTO;
  /** One more subscriber to that session's step stream. */
  watch(sessionId: string): void;
  unwatch(sessionId: string): void;
  /** Drops the records of sessions the registry no longer holds as live (run after each reconciliation). */
  sweep(): void;
}

export interface ActivityDeps {
  bus: EventBus;
  clock: Clock;
  log: Logger;
  pauses: Pick<PauseService, 'isPaused' | 'list' | 'onChange' | 'markHit' | 'clearHit'>;
  isSystem: (sessionId: string) => boolean;
  /** The registry knows the session and it has not ended; activity for anything else is ignored. */
  isLive: (sessionId: string) => boolean;
}

type MetersEvent = Extract<ActivitySpoolEvent, { event: 'meters' }>;

/** A turn is still running in these states; any other state ends it (open steps close, helpers leave). */
const TURN_STATES: ReadonlySet<SessionState> = new Set(['working', 'waiting_question', 'waiting_permission']);

function bareView(sessionId: string, paused: boolean, turnStartedAt: string | null = null): SessionActivityDTO {
  return { sessionId, tool: null, paused, helpers: 0, contextPct: null, lastStepAt: null, title: null, helperTypes: [], turnStartedAt };
}

function windowOf(wire: RateWindowWire | null): RateWindowDTO | null {
  return wire === null ? null : { usedPct: wire.used_pct, resetsAt: normalizeTs(wire.resets_at) };
}

/** In-memory activity per session: a one-second coalescer for the map and a 250 ms step stream for open agent views. */
export function createActivityService(deps: ActivityDeps): ActivityService {
  const records = new Map<string, SessionActivity>();
  const system = new Map<string, boolean>();
  /** When each session's running turn began (its `turnStartedAt`), so a turn end can expire silent helpers. */
  const turnStarts = new Map<string, string>();
  let offs: ReadonlyArray<() => void> = [];
  let running = false;

  const paused = (sessionId: string): boolean => deps.pauses.isPaused(sessionId);
  /** The answer never changes for an id, so the session lookup runs once per session, not once per step. */
  function isSystem(sessionId: string): boolean {
    const known = system.get(sessionId);
    if (known !== undefined) return known;
    const answer = deps.isSystem(sessionId);
    system.set(sessionId, answer);
    return answer;
  }

  const map = createMapCoalescer({
    intervalMs: ACTIVITY_BROADCAST_MS,
    viewOf: (sessionId) => {
      const record = records.get(sessionId);
      const turn = turnStarts.get(sessionId) ?? null;
      return record === undefined ? bareView(sessionId, paused(sessionId), turn) : toMapView(record, paused(sessionId), turn);
    },
    keep: (sessionId) => records.has(sessionId) || paused(sessionId),
    emit: (items) => deps.bus.emit('activity.updated', { items }),
  });
  const stream = createStepStream({
    flushMs: STEPS_FLUSH_MS,
    current: (sessionId) => records.get(sessionId),
    emit: (payload) => deps.bus.emit('steps.appended', payload),
  });

  function replace(sessionId: string, prev: SessionActivity, next: SessionActivity): void {
    if (next === prev) return;
    records.set(sessionId, next);
    if (isSystem(sessionId)) return;
    map.mark(sessionId);
    stream.collect(sessionId, prev, next);
  }

  function emitMeters(host: HostId, sessionId: string | null, event: MetersEvent): void {
    deps.bus.emit('meters.updated', {
      host, sessionId, fiveHour: windowOf(event.data.five_hour), sevenDay: windowOf(event.data.seven_day), at: normalizeTs(event.ts),
    });
  }

  function accept(host: HostId, event: ActivitySpoolEvent, replay: boolean): void {
    if (!running) return;
    const sessionId = sessionIdForEvent(host, event);
    if (event.event === 'meters') emitMeters(host, sessionId, event);
    if (sessionId === null) return;
    const existing = records.get(sessionId);
    // A record is dropped when its session ends, so only a new one needs the registry's word.
    if (existing === undefined && !deps.isLive(sessionId)) return;
    const prev = existing ?? emptyActivity(sessionId);
    const next = applyActivity(prev, event, replay);
    replace(sessionId, prev, next);
    if (event.event === 'paused') deps.pauses.markHit(sessionId);
    else if (prev.pauseHitAt !== null && next.pauseHitAt === null) deps.pauses.clearHit(sessionId);
  }

  /** The session ended or was removed: its record goes, and the map hears it once (only if it ever had one). */
  function forget(sessionId: string): void {
    const hidden = isSystem(sessionId);
    const had = records.delete(sessionId);
    turnStarts.delete(sessionId);
    stream.drop(sessionId);
    system.delete(sessionId);
    if (had && !hidden) map.mark(sessionId);
  }

  function onSession(session: SessionDTO): void {
    if (session.state === 'ended') {
      forget(session.id);
      return;
    }
    if (TURN_STATES.has(session.state)) {
      if (session.turnStartedAt !== null && turnStarts.get(session.id) !== session.turnStartedAt) {
        turnStarts.set(session.id, session.turnStartedAt);
        // The map shows how long the turn has run; a record from an earlier turn learns the new start.
        if (records.has(session.id) && !isSystem(session.id)) map.mark(session.id);
      }
      return;
    }
    const turnStartedAt = turnStarts.get(session.id) ?? null;
    turnStarts.delete(session.id);
    if (turnStartedAt !== null && records.has(session.id) && !isSystem(session.id)) map.mark(session.id);
    const record = records.get(session.id);
    if (record === undefined) return;
    const ended = endTurn(record, isoNow(deps.clock), turnStartedAt);
    // A pause that stopped the turn is still in force: the hit stays visible until the owner resumes.
    const held = paused(session.id) && record.pauseHitAt !== null && ended.pauseHitAt === null
      ? { ...ended, pauseHitAt: record.pauseHitAt }
      : ended;
    replace(session.id, record, held);
  }

  function onPauseChange(sessionId: string): void {
    if (isSystem(sessionId)) return;
    const record = records.get(sessionId);
    if (record !== undefined && record.pauseHitAt !== null && !paused(sessionId)) replace(sessionId, record, { ...record, pauseHitAt: null });
    else map.mark(sessionId);
  }

  function snapshot(): SessionActivityDTO[] {
    const views = [...records.values()]
      .filter((record) => !isSystem(record.sessionId))
      .map((record) => toMapView(record, paused(record.sessionId), turnStarts.get(record.sessionId) ?? null));
    const bare = deps.pauses.list()
      .filter((sessionId) => !records.has(sessionId) && !isSystem(sessionId))
      .map((sessionId) => bareView(sessionId, true));
    return [...views, ...bare];
  }

  return {
    accept,
    snapshot,
    detail: (sessionId) => toDetail(records.get(sessionId) ?? emptyActivity(sessionId), paused(sessionId)),
    watch: (sessionId) => stream.watch(sessionId),
    unwatch: (sessionId) => stream.unwatch(sessionId),
    sweep() {
      for (const sessionId of [...records.keys()]) {
        if (!deps.isLive(sessionId)) forget(sessionId);
      }
    },
    start() {
      if (running) return;
      running = true;
      offs = [
        deps.bus.on('session.updated', onSession),
        deps.bus.on('session.removed', ({ id }) => forget(id)),
        deps.pauses.onChange(onPauseChange),
      ];
    },
    stop() {
      running = false;
      for (const off of offs) off();
      offs = [];
      map.stop();
      stream.stop();
      records.clear();
      system.clear();
      turnStarts.clear();
    },
  };
}
