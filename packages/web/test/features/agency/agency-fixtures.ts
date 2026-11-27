import { buildSnapshot, type AgencySnapshot, type SnapshotInput } from '@luady/office';
import type { OverviewDTO, QuestionDTO, ServerDTO, SessionDTO } from '@luady/shared';
import { NOW, luadyStatus, overview, question, server, session } from '../../fixtures.js';
import { classicRoomDtos } from '../../room-fixtures.js';

/** A fleet of four servers, one room each. */
export function fleet(): ServerDTO[] {
  return [server({ name: 'birch' }), server({ name: 'ash' }), server({ name: 'cedar' }), server({ name: 'local' })];
}

/** A registered owner session on a server, id `<host>:<name>`. */
export function agent(host: SessionDTO['host'], name: string, over: Partial<SessionDTO> = {}): SessionDTO {
  return session({
    id: `${host}:${name}`, host, target: `${name}:0.0`, project: name, displayName: name,
    cwd: `/home/dev/projects/${name}`, state: 'working', ...over,
  });
}

/** A pending question of one session, asked `minutes` after NOW. */
export function askOf(sessionId: string, qid: string, minutes = 0): QuestionDTO {
  return question({ qid, sessionId, createdAt: new Date(Date.parse(NOW) + minutes * 60_000).toISOString() });
}

export const AGENTS: readonly SessionDTO[] = [
  agent('birch', 'app-backend'),
  agent('birch', 'jira-1105', { state: 'idle' }),
  agent('ash', 'harbor-web', { state: 'waiting_question', pendingQid: 'QFIRST01' }),
  agent('cedar', 'meadow-vat', { state: 'error' }),
  agent('local', 'client-preferences', { state: 'starting' }),
];

export const AGENT_QUESTIONS: readonly QuestionDTO[] = [askOf('ash:harbor-web', 'QFIRST01')];

/** The classic office as the hub sends it: four servers, their four rooms, five agents. */
export function fleetOverview(over: Partial<OverviewDTO> = {}): OverviewDTO {
  return overview({ servers: fleet(), rooms: classicRoomDtos(), sessions: [...AGENTS], questions: [...AGENT_QUESTIONS], actions: [], ...over });
}

/** The classic office as data; `rooms` defaults to the classic four as rooms. */
export function snapshotOf(over: Partial<SnapshotInput> = {}): AgencySnapshot {
  return buildSnapshot({
    servers: fleet(), rooms: classicRoomDtos(), sessions: AGENTS, questions: AGENT_QUESTIONS, luady: luadyStatus(),
    now: Date.parse(NOW), previousSeats: {}, ...over,
  });
}
