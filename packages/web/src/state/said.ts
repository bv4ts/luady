import type { SaidDTO } from '@luady/shared';

/**
 * The newest thing a session said. `seq` is its arrival number: every live `session.said` gets the next one, so the
 * bubbles can tell a new message from one they showed already. 0 = it came with a load (seen before, not new).
 */
export interface SaidEntry {
  readonly said: SaidDTO;
  readonly seq: number;
}

export interface SaidSlice {
  readonly bySession: Readonly<Record<string, SaidEntry>>;
  /** The last arrival number handed out; only grows. */
  readonly seq: number;
}

export const EMPTY_SAID: SaidSlice = Object.freeze({ bySession: Object.freeze({}), seq: 0 });

/** A live `session.said`: it is the newest for its session and gets the next arrival number. */
export function receiveSaid(prev: SaidSlice, said: SaidDTO): SaidSlice {
  const seq = prev.seq + 1;
  return Object.freeze({ bySession: Object.freeze({ ...prev.bySession, [said.sessionId]: Object.freeze({ said, seq }) }), seq });
}

/** `GET /api/said`: fills sessions with nothing newer, as already seen (arrival number 0). */
export function loadSaid(prev: SaidSlice, items: readonly SaidDTO[]): SaidSlice {
  const fresh = items.filter((said) => {
    const known = prev.bySession[said.sessionId];
    return known === undefined || Date.parse(said.at) > Date.parse(known.said.at);
  });
  if (fresh.length === 0) return prev;
  const added = Object.fromEntries(fresh.map((said) => [said.sessionId, Object.freeze({ said, seq: 0 })]));
  return Object.freeze({ ...prev, bySession: Object.freeze({ ...prev.bySession, ...added }) });
}

/** The session left the map (`session.removed`). */
export function dropSaid(prev: SaidSlice, sessionId: string): SaidSlice {
  if (!Object.hasOwn(prev.bySession, sessionId)) return prev;
  const bySession = Object.fromEntries(Object.entries(prev.bySession).filter(([id]) => id !== sessionId));
  return Object.freeze({ ...prev, bySession: Object.freeze(bySession) });
}
