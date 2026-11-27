import type { HostId, SessionDTO, SpoolEvent } from '@luady/shared';
import type { EventBus, HubEvents, Logger, MemoryService } from '../core/contracts.js';
import { sessionIdForEvent } from './naming.js';
import { normalizeTs, reduceSession, type Reduction, type SessionRow, type SessionSignal } from './registry.js';
import { toSessionDto, type SessionsRepo } from './repo.js';

export interface SessionEventDeps {
  repo: SessionsRepo;
  bus: EventBus;
  memory: MemoryService;
  log: Logger;
  /**
   * True once the pause really stopped the session (its `paused` line was seen). Only then is a Stop held; a Stop while
   * the flag is merely set is a real end of turn.
   */
  isHeld?: (sessionId: string) => boolean;
}

export interface SessionEventHandler {
  apply(host: HostId, event: SpoolEvent, replay: boolean): void;
  /** The pause that held a finished turn is over: `sent` false = report it now; true = the turn goes on (stored only). */
  release(sessionId: string, sent: boolean): void;
}

interface HeldTurn {
  readonly finished: HubEvents['turn.finished'];
  readonly row: SessionRow;
  readonly extId: string;
}

type Finished = Extract<SessionSignal, { kind: 'turn_finished' }>;

type TurnStarted = Extract<SessionSignal, { kind: 'turn_started' }>;

export function durationSec(startedAt: string | null, endTs: string): number {
  if (startedAt === null) return 0;
  const ms = Date.parse(normalizeTs(endTs)) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
}

/** Applies spool events to session rows: persist, publish `session.updated`, then emit the derived signals. */
export function createSessionEventHandler(deps: SessionEventDeps): SessionEventHandler {
  /** Previous Stop per session: the start of a turn whose prompt was absorbed into the one before. */
  const lastStop = new Map<string, string>();
  /** Turns whose Stop arrived after a pause hit, waiting for the pause to be released. */
  const held = new Map<string, HeldTurn>();

  /** A turn is the interval between Stops; it is remote when ANY prompt accumulated in it matched an injection. */
  function withRemote(reduction: Reduction, event: SpoolEvent): SessionRow {
    const started = reduction.signals.find((signal): signal is TurnStarted => signal.kind === 'turn_started');
    const row = reduction.row;
    if (started === undefined || row.turnRemote) return row;
    return deps.repo.matchesInjection(row.id, started.promptSha256, normalizeTs(event.ts)) ? { ...row, turnRemote: true } : row;
  }

  function record(row: SessionRow, role: 'user' | 'assistant', text: string, extId: string): void {
    if (row.origin === 'system' || text.trim() === '') return;
    try {
      deps.memory.record({ thread: `session:${row.id}`, role, channel: null, text, extId });
    } catch (err) {
      deps.log.warn({ session: row.id, err: err instanceof Error ? err.message : String(err) }, 'cannot record session message');
    }
  }

  function finishTurn(row: SessionRow, session: SessionDTO, signal: Finished, event: SpoolEvent, replay: boolean): void {
    const startedAt = signal.startedAt ?? lastStop.get(row.id) ?? null;
    lastStop.set(row.id, normalizeTs(event.ts));
    const finished = { session, durationSec: durationSec(startedAt, event.ts), remote: signal.remote, lastMessage: signal.lastMessage, replay };
    if (deps.isHeld?.(row.id) === true) {
      held.set(row.id, { finished, row, extId: event.id });
      return;
    }
    deps.bus.emit('turn.finished', finished);
    record(row, 'assistant', signal.lastMessage, event.id);
  }

  function release(sessionId: string, sent: boolean): void {
    const turn = held.get(sessionId);
    if (turn === undefined) return;
    held.delete(sessionId);
    record(turn.row, 'assistant', turn.finished.lastMessage, turn.extId);
    if (sent) return;
    const latest = deps.repo.get(sessionId);
    deps.bus.emit('turn.finished', { ...turn.finished, session: latest === undefined ? turn.finished.session : toSessionDto(latest) });
  }

  function emitSignal(row: SessionRow, session: SessionDTO, signal: SessionSignal, event: SpoolEvent, replay: boolean): void {
    switch (signal.kind) {
      case 'turn_started':
        record(row, 'user', signal.preview, event.id);
        return;
      case 'turn_finished':
        finishTurn(row, session, signal, event, replay);
        return;
      case 'failed':
        deps.bus.emit('session.failed', { session, error: signal.error, replay });
        return;
      case 'ended':
        deps.bus.emit('session.ended', { session, unexpected: false, reason: signal.reason, replay });
        return;
      case 'usage':
        deps.bus.emit('usage.notice', { session, message: signal.message, replay });
        return;
      case 'report':
        deps.bus.emit('session.report', { session, text: signal.text, replay });
        record(row, 'assistant', signal.text, event.id);
        return;
    }
  }

  return {
    release,
    apply(host, event, replay) {
      const id = sessionIdForEvent(host, event);
      if (id === null) return;
      const reduction = reduceSession(deps.repo.get(id) ?? null, host, event);
      if (reduction === null) return;
      const row = withRemote(reduction, event);
      deps.repo.save(row);
      const session = toSessionDto(row);
      deps.bus.emit('session.updated', session);
      for (const signal of reduction.signals) emitSignal(row, session, signal, event, replay);
    },
  };
}
