import {
  buildRoomIndex, globMatch, roomOf, type ProjectDTO, type RoomDTO, type RoomPreviewBody, type RoomPreviewDTO, type SessionDTO,
} from '@luady/shared';

/**
 * "This room will hold…": which live sessions and known projects a room would take with these matches,
 * and which other rooms' matches also fit those projects (the overlaps the website warns about).
 */

/** The candidate's id while it has none: a space never appears in a room id, so it collides with no room. */
export const PREVIEW_ID = ' preview';

interface Place { readonly host: string; readonly project: string | null; readonly cwd: string | null }

const projectPlace = (project: ProjectDTO): Place => ({ host: project.server, project: project.name, cwd: project.path });
const projectLabel = (project: ProjectDTO): string => `${project.server}/${project.name}`;

/** A room's matches fit the place, on a host the room covers (its own, or any for a project room with no host). */
function fits(room: Pick<RoomDTO, 'kind' | 'host' | 'match'>, place: Place): boolean {
  const onHost = room.host === place.host || (room.kind === 'project' && room.host === null);
  return onHost && room.match.some((m) => {
    const text = m.by === 'path' ? place.cwd : place.project;
    return text !== null && globMatch(m.glob, text, m.by);
  });
}

/** The live sessions a map would place: not the manager's own, not ended. */
const isLive = (session: SessionDTO): boolean => session.origin !== 'system' && session.state !== 'ended';

export function previewRoom(
  body: RoomPreviewBody, candidate: RoomDTO, rooms: readonly RoomDTO[], sessions: readonly SessionDTO[], projects: readonly ProjectDTO[],
): RoomPreviewDTO {
  const others = rooms.filter((room) => room.id !== candidate.id);
  const index = buildRoomIndex([...others, candidate]);
  // What the room takes by its matches (or, with none, its whole host): a guest it would only shelter is not counted.
  const lands = (place: Place): boolean => {
    const at = roomOf(place, index);
    return at !== null && at.room === candidate.id && !at.guest;
  };
  const taken = projects.filter((project) => lands(projectPlace(project)));
  const overlaps = others
    .filter((room) => room.kind === 'project' || room.host === body.host)
    .map((room) => ({
      room: room.id,
      projects: projects.filter((project) => fits(candidate, projectPlace(project)) && fits(room, projectPlace(project))).map(projectLabel),
    }))
    .filter((overlap) => overlap.projects.length > 0);
  return {
    sessions: sessions.filter(isLive).filter(lands).map((session) => session.id),
    projects: taken.map(projectLabel),
    overlaps,
  };
}
