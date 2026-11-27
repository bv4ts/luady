import { LIMITS, type MissionDTO } from '@luady/shared';
import { clipUnits } from '../board/text.js';
import type { MissionPhase } from './format.js';

/** One row of the `missions` table (migration 003). */
export interface MissionRow {
  session_id: string;
  label: string;
  title: string;
  phase: MissionPhase;
  turns: number;
  note: string | null;
  last_text: string | null;
  managed: number;
  chat_msg_id: string | null;
  sent_at: string | null;
  opened_at: string;
  idle_since: string | null;
}

/** A row is open while it exists, so only the three live phases reach the website ('done'/'ended' rows are gone). */
function livePhase(phase: MissionPhase): MissionDTO['phase'] {
  return phase === 'working' || phase === 'waiting' ? phase : 'idle';
}

/** The website's view of an open mission; the last message is cut to LIMITS.missionLastTextMax. */
export function missionDto(row: MissionRow): MissionDTO {
  return {
    sessionId: row.session_id,
    label: row.label,
    title: row.title,
    phase: livePhase(row.phase),
    turns: row.turns,
    note: row.note,
    lastText: row.last_text === null ? null : clipUnits(row.last_text, LIMITS.missionLastTextMax),
    openedAt: row.opened_at,
    idleSince: row.idle_since,
  };
}
