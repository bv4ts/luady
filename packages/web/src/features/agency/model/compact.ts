import type { SessionDTO } from '@luady/shared';

/** From this much context in use the agent view and the menu offer "Compact now". */
export const COMPACT_FROM_PCT = 60;
/** What "Compact now" types into the session. */
export const COMPACT_TEXT = '/compact';

/**
 * True when "Compact now" makes sense: a reading of 60% or more, and a session that can take a message (not ended,
 * not waiting on a question of its own: the answer card comes first).
 */
export function canCompact(session: Pick<SessionDTO, 'state' | 'pendingQid'>, contextPct: number | null | undefined): boolean {
  if (contextPct === null || contextPct === undefined || !Number.isFinite(contextPct)) return false;
  if (session.state === 'ended' || session.pendingQid !== null) return false;
  return contextPct >= COMPACT_FROM_PCT;
}
