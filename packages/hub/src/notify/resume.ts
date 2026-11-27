import type { SessionDTO } from '@luady/shared';
import type { Clock, Logger, SessionService } from '../core/contracts.js';

/**
 * Claude Code ends a turn when the API stream drops after visible output (it retries only before that). The session
 * itself is fine: it needs a "carry on". Such drops happen a few times per streaming hour in main sessions.
 */
const CONNECTION_DROP_RE = /Connection (lost|closed) mid-response|Connection to the API was lost/i;

export const RESUME_DELAY_MS = 5_000;
export const RESUME_WINDOW_MS = 30 * 60_000;
/** More drops than this in the window means something is really wrong: Luady investigates instead. */
export const RESUME_MAX = 3;
export const RESUME_TEXT = 'Your last reply was cut off by a connection error. Carry on exactly where you stopped.';

export function isConnectionDrop(error: string): boolean {
  return CONNECTION_DROP_RE.test(error);
}

export interface AutoResumerDeps {
  sessions: Pick<SessionService, 'send'>;
  clock: Clock;
  log: Logger;
  /** The carry-on could not be sent (question pending, session ended…): the usual repair path takes over. */
  onGiveUp: (session: SessionDTO, error: string) => void;
  /**
   * The pause really stopped the session (its `paused` line was seen): a drop is held, nothing is typed and it is not
   * handed to Luady until the pause is released. A flag that has not hit yet changes nothing.
   */
  isHeld?: (sessionId: string) => boolean;
}

export interface AutoResumer {
  /** True when the failure is a connection drop this resumer handles (or holds, when paused); false leaves it to the usual path. */
  tryResume(session: SessionDTO, error: string): boolean;
  /** The pause was released: a held drop is carried on now (`sent` false), or dropped (`sent` true, the turn goes on). */
  release(sessionId: string, sent: boolean): void;
  stop(): void;
}

interface HeldDrop {
  readonly session: SessionDTO;
  readonly error: string;
}

export function createAutoResumer(deps: AutoResumerDeps): AutoResumer {
  const attempts = new Map<string, readonly number[]>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const held = new Map<string, HeldDrop>();
  const isHeld = (sessionId: string): boolean => deps.isHeld?.(sessionId) === true;

  function recent(sessionId: string, now: number): readonly number[] {
    return (attempts.get(sessionId) ?? []).filter((at) => now - at < RESUME_WINDOW_MS);
  }

  async function resume(session: SessionDTO, error: string): Promise<void> {
    if (isHeld(session.id)) {
      held.set(session.id, { session, error });
      return;
    }
    try {
      await deps.sessions.send(session.id, RESUME_TEXT, 'event');
      deps.log.info({ session: session.id }, 'resumed a session after a connection drop');
    } catch (err) {
      deps.log.warn({ session: session.id, err: err instanceof Error ? err.message : String(err) }, 'auto-resume failed');
      deps.onGiveUp(session, error);
    }
  }

  function tryResume(session: SessionDTO, error: string): boolean {
    if (session.origin === 'system' || !isConnectionDrop(error)) return false;
    if (isHeld(session.id)) {
      held.set(session.id, { session, error });
      return true;
    }
    const now = deps.clock.now().getTime();
    const tries = recent(session.id, now);
    if (tries.length >= RESUME_MAX) return false;
    attempts.set(session.id, [...tries, now]);
    const timer = setTimeout(() => {
      timers.delete(timer);
      void resume(session, error);
    }, RESUME_DELAY_MS);
    timers.add(timer);
    return true;
  }

  return {
    tryResume,
    release(sessionId, sent) {
      const drop = held.get(sessionId);
      held.delete(sessionId);
      if (drop === undefined || sent) return;
      if (!tryResume(drop.session, drop.error)) deps.onGiveUp(drop.session, drop.error);
    },
    stop() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      held.clear();
    },
  };
}
