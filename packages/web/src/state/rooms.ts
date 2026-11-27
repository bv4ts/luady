import { isLocalHost, isSelfHost, type ChannelInfoDTO, type HostDTO, type RoomDTO, type ServerDTO, type SessionDTO } from '@luady/shared';
import { buildRoomIndex, roomOf, type RoomIndex } from '@luady/shared/pure';

/**
 * Slices of the store: the rooms, the hosts, the declared channels and the setup state, with
 * their selectors. Every selector is cheap on any number of rooms: sorts and indexes are built once per array.
 */

/** A slice of the app state with what these selectors read. */
export interface RoomsSlice {
  readonly rooms: readonly RoomDTO[];
  readonly servers: readonly ServerDTO[];
  /** Hosts from `hosts.changed`; null until the hub sent the first list (a hub without the hosts service sends none). */
  readonly hosts: readonly HostDTO[] | null;
  readonly channels: readonly ChannelInfoDTO[];
}

const SORTED = new WeakMap<readonly RoomDTO[], readonly RoomDTO[]>();
const INDEXES = new WeakMap<readonly RoomDTO[], RoomIndex>();

/** The rooms as the hub sent them. */
export function rooms(state: Pick<RoomsSlice, 'rooms'>): readonly RoomDTO[] {
  return state.rooms;
}

/** The rooms in slot order; the same array for the same rooms. */
export function roomsByPosition(state: Pick<RoomsSlice, 'rooms'>): readonly RoomDTO[] {
  const known = SORTED.get(state.rooms);
  if (known !== undefined) return known;
  const sorted = Object.freeze(state.rooms.toSorted((a, b) => a.position - b.position));
  SORTED.set(state.rooms, sorted);
  return sorted;
}

/** The room index of these rooms, built once per array. */
export function roomIndexOf(list: readonly RoomDTO[]): RoomIndex {
  const known = INDEXES.get(list);
  if (known !== undefined) return known;
  const made = buildRoomIndex(list);
  INDEXES.set(list, made);
  return made;
}

/** Which room a session sits in, and whether as a guest; null when it is not on the map (or is the manager's own). */
export function roomOfSession(
  state: Pick<RoomsSlice, 'rooms'>, session: Pick<SessionDTO, 'host' | 'project' | 'cwd'>,
): { readonly room: string; readonly guest: boolean } | null {
  if (isSelfHost(session.host)) return null;
  return roomOf(session, roomIndexOf(state.rooms));
}

/** The declared channels (add-ons and their states). */
export function channels(state: Pick<RoomsSlice, 'channels'>): readonly ChannelInfoDTO[] {
  return state.channels;
}

/** The hosts as `hosts.changed` last listed them; null before the first list. */
export function hosts(state: Pick<RoomsSlice, 'hosts'>): readonly HostDTO[] | null {
  return state.hosts;
}

/** A host a room can be given: its id, whether it is "this computer", and its folders. */
export interface HostChoice {
  readonly id: string;
  readonly local: boolean;
  readonly projectsRoot: string | null;
  readonly homeDir: string | null;
}

/**
 * The hosts a room may be given: pinned SSH hosts and the local host. From the hosts list when the hub
 * has sent one, else from the overview's servers (the fleet holds only usable hosts). Never the manager's own host.
 */
export function hostChoices(state: Pick<RoomsSlice, 'hosts' | 'servers'>): readonly HostChoice[] {
  const list: HostChoice[] = state.hosts === null
    ? state.servers.map((s) => ({ id: s.name, local: s.kind === 'local' || isLocalHost(s.name), projectsRoot: s.projectsRoot, homeDir: s.homeDir }))
    : state.hosts.filter((h) => h.state === 'pinned').map((h) => ({ id: h.id, local: h.kind === 'local', projectsRoot: h.projectsRoot, homeDir: h.homeDir }));
  return list.filter((choice) => !isSelfHost(choice.id));
}

/** Channel rows of `channel.status`: the new state of one channel replaces its row, a new channel is added. */
export function upsertChannel(list: readonly ChannelInfoDTO[], channel: ChannelInfoDTO): readonly ChannelInfoDTO[] {
  const at = list.findIndex((one) => one.id === channel.id);
  return at === -1 ? [...list, channel] : list.map((one, i) => (i === at ? channel : one));
}
