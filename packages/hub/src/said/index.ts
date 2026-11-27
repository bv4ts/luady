import { LIMITS, isSelfHost, type SaidDTO, type SessionDTO } from '@luady/shared';
import type { Clock, EventBus, HubEvents, Logger, SaidService, SessionService } from '../core/contracts.js';
import { cutUnits } from '../board/text.js';

/** Everything the speech feed needs (wired in app.ts). */
export interface SaidDeps {
  bus: EventBus;
  clock: Clock;
  log: Logger;
  /** To skip Luady's own session and sessions that ended. */
  sessions: Pick<SessionService, 'get'>;
}

/** Luady's own session (the self host) and the hub's system sessions are never mirrored as a bubble. */
export function speaks(session: SessionDTO): boolean {
  return !isSelfHost(session.host) && session.origin !== 'system' && session.state !== 'ended';
}

/** What an agent said, cut for one speech bubble; null when there is nothing to show. */
export function saidOf(session: SessionDTO, kind: SaidDTO['kind'], text: string, at: string): SaidDTO | null {
  const clean = text.trim();
  if (clean === '') return null;
  const cut = cutUnits(clean, LIMITS.saidTextMax);
  return { sessionId: session.id, kind, text: cut.text, truncated: cut.truncated, at };
}

/**
 * Turn ends and `luady-report` lines become `session.said`. The newest per live session stays in
 * memory for GET /api/said and is forgotten when the session ends. Replays (old lines after an outage) are skipped.
 */
export function createSaidService(deps: SaidDeps): SaidService {
  const latest = new Map<string, SaidDTO>();
  let offs: Array<() => void> = [];

  function say(session: SessionDTO, kind: SaidDTO['kind'], text: string, replay: boolean): void {
    if (replay || !speaks(session)) return;
    const said = saidOf(session, kind, text, deps.clock.now().toISOString());
    if (said === null) return;
    latest.set(session.id, said);
    deps.bus.emit('session.said', said);
  }

  const forget = (sessionId: string): void => {
    latest.delete(sessionId);
  };

  return {
    list: () => [...latest.values()].filter((said) => {
      const session = deps.sessions.get(said.sessionId);
      return session !== undefined && speaks(session);
    }),
    start() {
      if (offs.length > 0) return;
      offs = [
        deps.bus.on('turn.finished', (e: HubEvents['turn.finished']) => say(e.session, 'reply', e.lastMessage, e.replay)),
        deps.bus.on('session.report', (e: HubEvents['session.report']) => say(e.session, 'report', e.text, e.replay)),
        deps.bus.on('session.ended', (e: HubEvents['session.ended']) => forget(e.session.id)),
        deps.bus.on('session.removed', ({ id }) => forget(id)),
        deps.bus.on('session.updated', (session) => {
          if (session.state === 'ended') forget(session.id);
        }),
      ];
    },
    stop() {
      for (const off of offs) off();
      offs = [];
      latest.clear();
    },
  };
}
