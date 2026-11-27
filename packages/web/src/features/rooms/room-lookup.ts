import { HQ_PALETTE, MUTE_PALETTE, type Palette } from '@luady/office';
import { isLocalHost, isSelfHost, managerName, type RoomDTO } from '@luady/shared';

/**
 * Names and colours of offices from the rooms: every drawer, chip and label reads them here, never from
 * fixed tables. A key is a room id, or a host id (read as its home room: its server or local room). The manager's own
 * host reads as HQ. A key nothing names reads as itself, never as "undefined".
 */
export interface RoomLookup {
  /** The rooms in slot order. */
  readonly list: readonly RoomDTO[];
  /** The room of a room id, else the home room of a host id. */
  room(key: string | null | undefined): RoomDTO | undefined;
  /** The room's name; the HQ name for the manager's host; '' for null; the key itself when no room names it. */
  roomName(key: string | null | undefined): string;
  /** The room's short name (chips, tags); as roomName otherwise. */
  roomShort(key: string | null | undefined): string;
  /** The room's colours; HQ's for the manager's host; grey for anything else. */
  roomPalette(key: string | null | undefined): Palette;
  /** The lowest-position room's id; null while the office has no rooms. */
  firstRoom(): string | null;
  /** A host as the owner knows it: its home room's name, "This computer", the HQ name, or the id. */
  hostLabel(host: string | null | undefined): string;
}

/** HQ's name as the owner reads it: the manager's display name, then HQ (never the self-host id). */
export function hqName(): string {
  return `${managerName()} HQ`;
}

const LOOKUPS = new WeakMap<readonly RoomDTO[], RoomLookup>();

/** The lookup of a rooms list (any order), built once per array. */
export function roomLookup(rooms: readonly RoomDTO[]): RoomLookup {
  const known = LOOKUPS.get(rooms);
  if (known !== undefined) return known;
  const list = Object.freeze(rooms.toSorted((a, b) => a.position - b.position));
  const byId = new Map(list.map((room) => [room.id, room]));
  const homes = new Map<string, RoomDTO>();
  for (const room of list) if (room.kind !== 'project' && room.host !== null && !homes.has(room.host)) homes.set(room.host, room);
  const room = (key: string | null | undefined): RoomDTO | undefined =>
    key === null || key === undefined ? undefined : byId.get(key) ?? homes.get(key);
  const named = (key: string | null | undefined, pick: (r: RoomDTO) => string): string => {
    if (key === null || key === undefined) return '';
    if (isSelfHost(key)) return hqName();
    const found = room(key);
    return found === undefined ? key : pick(found);
  };
  const made: RoomLookup = Object.freeze({
    list,
    room,
    roomName: (key: string | null | undefined) => named(key, (r) => r.name),
    roomShort: (key: string | null | undefined) => named(key, (r) => r.short),
    roomPalette: (key: string | null | undefined): Palette => {
      if (key !== null && key !== undefined && isSelfHost(key)) return HQ_PALETTE;
      const found = room(key);
      return found === undefined ? MUTE_PALETTE : Object.freeze({ base: found.colour, accent: found.accent });
    },
    firstRoom: () => list[0]?.id ?? null,
    hostLabel: (host: string | null | undefined): string => {
      if (host === null || host === undefined) return '';
      if (isSelfHost(host)) return hqName();
      const home = homes.get(host);
      if (home !== undefined) return home.name;
      return isLocalHost(host) ? 'This computer' : host;
    },
  });
  LOOKUPS.set(rooms, made);
  return made;
}
