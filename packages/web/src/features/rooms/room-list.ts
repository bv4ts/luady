import type { RoomDTO } from '@luady/shared';
import { gridFor, slotCountOf } from '@luady/shared/pure';
import type { RoomLookup } from './room-lookup.js';

/** A room's kind and server in words: "Server · Harbor box", "This computer", "Project · any server". */
export function roomWhere(room: RoomDTO, lookup: Pick<RoomLookup, 'hostLabel'>): string {
  const host = room.host === null ? 'any server' : (room.kind === 'project' ? lookup.hostLabel(room.host) : room.host);
  if (room.kind === 'local') return 'This computer';
  return room.kind === 'project' ? `Project · ${host}` : `Server · ${host}`;
}

/** True when a room's search words hold every word of the query (name, server and kind; any case). */
export function roomMatches(room: RoomDTO, query: string, lookup: Pick<RoomLookup, 'hostLabel'>): boolean {
  const words = query.toLocaleLowerCase('und').split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = [room.name, room.short, room.host ?? 'any', room.host === null ? '' : lookup.hostLabel(room.host), room.kind, roomWhere(room, lookup)]
    .join(' ').toLocaleLowerCase('und');
  return words.every((word) => text.includes(word));
}

/** True when some slot below the last room is empty (Close gaps would move rooms). */
export function hasGaps(rooms: readonly RoomDTO[]): boolean {
  return rooms.some((room, i) => room.position !== i);
}

export interface SpotChoice {
  readonly position: number;
  /** The room in that spot now; null for a free spot. */
  readonly room: RoomDTO | null;
}

/**
 * Where a room may move: every spot of the office's grid (free ones, or a swap with the room
 * there), and the next free spot when it lies beyond the grid. The room's own spot is left out.
 */
export function spotChoices(rooms: readonly RoomDTO[], self: RoomDTO): readonly SpotChoice[] {
  const byPosition = new Map(rooms.map((room) => [room.position, room]));
  const capacity = gridFor(slotCountOf(rooms.map((room) => room.position))).capacity;
  let lowest = 0;
  while (byPosition.has(lowest)) lowest += 1;
  const spots = Array.from({ length: Math.max(capacity, lowest + 1) }, (_, position) => position)
    .filter((position) => position < capacity || position === lowest);
  return spots.filter((position) => position !== self.position).map((position) => ({ position, room: byPosition.get(position) ?? null }));
}

/** The ids with one room moved before another (a drag in the list): the order the hub then numbers 0..n-1. */
export function reordered(ids: readonly string[], moved: string, before: string): readonly string[] {
  if (moved === before) return ids;
  const rest = ids.filter((id) => id !== moved);
  const at = rest.indexOf(before);
  return at === -1 ? ids : [...rest.slice(0, at), moved, ...rest.slice(at)];
}
