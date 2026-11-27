import { HQ_PALETTE, type Palette } from '@luady/office';
import { isSelfHost, type DelegateTo, type RoomDTO, type ServerDTO, type SessionDTO, managerName } from '@luady/shared';
import { compareSessions } from '../../../state/selectors.js';
import { roomLookup, type RoomLookup } from '../../rooms/room-lookup.js';
import { compareOffices, officeHosts } from '../drawers/library/library-model.js';
import { stateWords } from '../model/words.js';

/** One choice in the Give to… picker. */
export interface GiveTarget {
  readonly key: string;
  readonly to: DelegateTo;
  readonly title: string;
  readonly detail: string;
  readonly palette: Palette;
  /** Shown but not pressable (an offline server cannot start a session). */
  readonly disabled: boolean;
}

export interface GiveRoom {
  readonly server: string;
  readonly name: string;
  readonly palette: Palette;
  readonly newSession: GiveTarget;
  readonly sessions: readonly GiveTarget[];
}

export interface GiveTargets {
  readonly auto: GiveTarget;
  readonly rooms: readonly GiveRoom[];
}

const AUTO: GiveTarget = Object.freeze({
  key: 'auto', to: { kind: 'auto' as const }, title: `Let ${managerName()} decide`,
  detail: 'He groups the work by project and picks or starts the sessions.', palette: HQ_PALETTE, disabled: false,
});

function sessionTarget(session: SessionDTO, palette: Palette): GiveTarget {
  const project = session.project === null || session.project === session.displayName ? '' : ` · ${session.project}`;
  return {
    key: `session:${session.id}`, to: { kind: 'session', id: session.id }, title: session.displayName,
    detail: `${stateWords(session.state)}${project}`, palette, disabled: false,
  };
}

/** The hosts work can go to: the hub's servers in reading order; before the hub has said, the hosts of the rooms. */
function targetHosts(servers: readonly ServerDTO[], lookup: RoomLookup): readonly string[] {
  const known = servers.map((server) => server.name).filter((host) => !isSelfHost(host));
  const hosts = known.length > 0 ? known : officeHosts(lookup);
  return [...new Set(hosts)].toSorted(compareOffices(lookup));
}

/** "Let Luady decide", then every office with "A new session in …" and its live sessions, any number of them. */
export function giveTargets(rooms: readonly RoomDTO[], servers: readonly ServerDTO[], sessions: readonly SessionDTO[]): GiveTargets {
  const lookup = roomLookup(rooms);
  const status = new Map(servers.map((server) => [server.name, server.status] as const));
  const giveRooms = targetHosts(servers, lookup).map((server): GiveRoom => {
    const name = lookup.hostLabel(server);
    const palette = lookup.roomPalette(server);
    const offline = (status.get(server) ?? 'online') === 'offline';
    const live = sessions.filter((session) => session.host === server && session.state !== 'ended').toSorted(compareSessions);
    return {
      server, name, palette,
      newSession: {
        key: `server:${server}`, to: { kind: 'server', server }, title: `A new session in ${name}`,
        detail: offline ? 'This server is offline.' : `${managerName()} starts it and writes the brief.`, palette, disabled: offline,
      },
      sessions: live.map((session) => sessionTarget(session, palette)),
    };
  });
  return { auto: AUTO, rooms: giveRooms };
}

/** The name of a target for the toast: "Orchard", a session's name, or null for Luady's choice. */
export function targetName(to: DelegateTo, sessions: readonly SessionDTO[], lookup: RoomLookup): string | null {
  if (to.kind === 'auto') return null;
  if (to.kind === 'server') return lookup.hostLabel(to.server);
  return sessions.find((session) => session.id === to.id)?.displayName ?? 'that session';
}

/** The toast after a give: "Luady is on it: 3 cards to Orchard." or that it waits for him. */
export function giveToast(label: string, luady: 'sent' | 'queued', name: string | null = null): string {
  const where = name === null ? '' : ` to ${name}`;
  return luady === 'sent'
    ? `${managerName()} is on it: ${label}${where}.`
    : `Waiting for ${managerName()}: ${label}${where}. He gets it when he is back.`;
}

/** More servers than this and "Give to…" offers a search box: the list is long enough to look for one. */
export const GIVE_SEARCH_AFTER = 8;

/**
 * The rooms whose name or server matches the search (case-insensitive, any part); in a room that does not match, only
 * its sessions whose name does. An empty search keeps everything.
 */
export function filterGiveRooms(rooms: readonly GiveRoom[], search: string): readonly GiveRoom[] {
  const words = search.trim().toLowerCase();
  if (words === '') return rooms;
  const has = (text: string): boolean => text.toLowerCase().includes(words);
  return rooms.flatMap((room) => {
    if (has(room.name) || has(room.server)) return [room];
    const sessions = room.sessions.filter((target) => has(target.title));
    return sessions.length === 0 ? [] : [{ ...room, sessions }];
  });
}
