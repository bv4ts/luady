import type { RoomDTO } from '@luady/shared';

/**
 * The names the owner knows for offices come from the rooms (rooms/): a room id reads as the room's name, a host as
 * its home room's name (its server or local room), anything else as itself. There are no fixed names in code.
 */

/** The office name of a room id or a host in a list of rooms; the key itself when no room names it. */
export function officeNameIn(rooms: readonly RoomDTO[], key: string): string {
  const byId = rooms.find((room) => room.id === key);
  if (byId !== undefined) return byId.name;
  return rooms.find((room) => room.kind !== 'project' && room.host === key)?.name ?? key;
}

/** Hosts in the office's order: by their home room's slot, hosts without a room after them by id. */
export function officeOrder(rooms: readonly RoomDTO[]): (a: string, b: string) => number {
  const slot = new Map(rooms.filter((room) => room.kind !== 'project' && room.host !== null).map((room) => [room.host as string, room.position]));
  return (a, b) => (slot.get(a) ?? Number.POSITIVE_INFINITY) - (slot.get(b) ?? Number.POSITIVE_INFINITY) || a.localeCompare(b);
}
