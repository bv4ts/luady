import type { MissionDTO } from '@luady/shared';

/** The missions Luady runs now, by session id. */
export type MissionMap = Readonly<Record<string, MissionDTO>>;

export const EMPTY_MISSIONS: MissionMap = Object.freeze({});

/** `GET /api/missions`: the whole list. */
export function loadMissions(items: readonly MissionDTO[]): MissionMap {
  return Object.freeze(Object.fromEntries(items.map((mission) => [mission.sessionId, mission])));
}

/** `mission.updated`. */
export function upsertMission(prev: MissionMap, mission: MissionDTO): MissionMap {
  return Object.freeze({ ...prev, [mission.sessionId]: mission });
}

/** `mission.removed` (done or ended). */
export function removeMission(prev: MissionMap, sessionId: string): MissionMap {
  if (!Object.hasOwn(prev, sessionId)) return prev;
  return Object.freeze(Object.fromEntries(Object.entries(prev).filter(([id]) => id !== sessionId)));
}
