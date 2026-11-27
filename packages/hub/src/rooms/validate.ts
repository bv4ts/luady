import {
  DEFAULT_ROOM_PALETTE, LIMITS, LOCAL_HOST_ID, ROOM_SPECIES, ROOM_WARN_DELTA_E, clampBody, deltaE2000, isNewRoomId, isSelfHost,
  isUnderRoot, managerName, nearReserved, type ProjectMatch, type RoomKind, type RoomSpecies, type RoomWarning,
} from '@luady/shared';
import type { Fleet } from '../core/contracts.js';
import { ValidationError } from '../core/errors.js';
import { RoomConflictError } from './errors.js';
import type { RoomRecord } from './repo.js';

/**
 * Room validation. Pure: every check reads only its arguments. There is no
 * check on the number of rooms; only the per-field limits exist.
 */

/** Positions from this one on are refused, as the office refuses them (a sanity bound, not a limit on rooms). */
export const ROOM_POSITION_LIMIT = 100_000;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const NAME_GLOB_RE = /^[A-Za-z0-9._*?-]{1,64}$/;
const PATH_GLOB_RE = /^\/[A-Za-z0-9._*?/-]{0,127}$/;

/** Trimmed and NFC-normalised; 1-`max` characters; no control characters. */
export function cleanText(value: string, max: number, what: string): string {
  const clean = value.normalize('NFC').trim();
  if (clean.length === 0 || clean.length > max) throw new ValidationError(`A room ${what} needs 1-${max} characters`);
  if (CONTROL_RE.test(clean)) throw new ValidationError(`A room ${what} may not hold control characters`);
  return clean;
}

/** The form two names are compared in: NFC, then Unicode lower case without a locale. */
export function foldName(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('und');
}

/** Names no room may take: the headquarters' own. */
export function reservedNames(): readonly string[] {
  return [foldName('HQ'), foldName(`${managerName()} HQ`)];
}

/** Refuses a name another room (or HQ) already has, compared after Unicode case folding. */
export function checkNameFree(name: string, rooms: readonly RoomRecord[], self: string | null): void {
  const folded = foldName(name);
  if (reservedNames().includes(folded) || rooms.some((room) => room.id !== self && foldName(room.name) === folded)) {
    throw new RoomConflictError('name_taken', `A room is already called ${JSON.stringify(name)}`);
  }
}

/** The short name: the name when it fits, else its first word, cut to fit. */
export function shortFor(name: string): string {
  if (name.length <= LIMITS.roomShortMax) return name;
  const first = name.split(/\s+/)[0] ?? name;
  return first.slice(0, LIMITS.roomShortMax);
}

const SLUG_MAX = 32;

/** The ASCII slug of a name: letters and digits, dashes between words, a letter first. */
function baseSlug(name: string): string {
  const ascii = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const dashed = ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const lettered = /^[a-z]/.test(dashed) ? dashed : `room-${dashed}`.replace(/-+$/, '');
  return lettered.slice(0, SLUG_MAX).replace(/-+$/, '');
}

/**
 * The id a new room gets from its name: the slug, or the slug with `-2`, `-3`, … when it is taken or reserved. Ids
 * never change once given.
 */
export function slugFor(name: string, taken: ReadonlySet<string>): string {
  let base = baseSlug(name);
  if (base.length < 2) base = 'room';
  if (!isNewRoomId(base)) base = `room-${base}`.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (isNewRoomId(base) && !taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (isNewRoomId(candidate) && !taken.has(candidate)) return candidate;
  }
}

/** The host a room of this kind takes when the body names none: the local host for a `local` room. */
export function defaultHost(kind: RoomKind, host: string | null | undefined): string | null {
  if (host !== undefined) return host;
  return kind === 'local' ? LOCAL_HOST_ID : null;
}

/**
 * The room-kind host rules: a `server` room needs a pinned SSH host, a `local` room the local host, a
 * `project` room either one or none. The self host never has a room. One home room (server or local) per host.
 */
export function checkHost(
  kind: RoomKind, host: string | null, fleet: Pick<Fleet, 'hasServer' | 'hasLocal'>, rooms: readonly RoomRecord[], self: string | null,
): void {
  if (host !== null && isSelfHost(host)) throw new ValidationError('The manager\'s own host has no room');
  if (kind === 'server' && (host === null || !fleet.hasServer(host))) {
    throw new ValidationError(`A server room needs a server the hub reaches over SSH${host === null ? '' : `; ${host} is not one`}`);
  }
  if (kind === 'local' && (host === null || !fleet.hasLocal(host))) {
    throw new ValidationError(`A room for this computer needs this computer set up as a host${host === null ? '' : `; ${host} is not it`}`);
  }
  if (kind === 'project' && host !== null && !fleet.hasServer(host) && !fleet.hasLocal(host)) {
    throw new ValidationError(`Unknown host: ${host}`);
  }
  if (kind !== 'project' && rooms.some((room) => room.id !== self && room.kind !== 'project' && room.host === host)) {
    throw new RoomConflictError('home_room_exists', `${host ?? 'This host'} already has its room`);
  }
}

/** A path glob without its trailing `/*` or `/**`: the folder it names. */
const globFolder = (glob: string): string => glob.replace(/\/\*\*?$/, '') || '/';

/**
 * Name globs `^[A-Za-z0-9._*?-]{1,64}$`; path globs absolute, without `..`, and inside the host's projects folder once a
 * trailing `/*` or `/**` is removed (any host's folder for a project room with no host). A project room needs a match.
 */
export function checkMatches(kind: RoomKind, matches: readonly ProjectMatch[], roots: readonly string[]): void {
  if (kind === 'project' && matches.length === 0) throw new ValidationError('A project room needs at least one match');
  for (const m of matches) {
    if (m.by === 'name') {
      if (!NAME_GLOB_RE.test(m.glob)) throw new ValidationError(`Not a name match: ${JSON.stringify(m.glob)} (letters, digits, . _ - * ?)`);
      continue;
    }
    if (!PATH_GLOB_RE.test(m.glob) || m.glob.split('/').includes('..')) {
      throw new ValidationError(`Not a path match: ${JSON.stringify(m.glob)} (an absolute folder, with * and ? only)`);
    }
    const folder = globFolder(m.glob);
    if (roots.length > 0 && !roots.some((root) => isUnderRoot(folder, root))) {
      throw new ValidationError(`${m.glob} is outside the projects folder${roots.length === 1 ? ` ${roots[0] ?? ''}` : 's'}`);
    }
  }
}

/** Refuses a stray huge position (the office lays positions out only below the same bound). */
export function checkPositionBound(position: number): void {
  if (position >= ROOM_POSITION_LIMIT) throw new ValidationError(`A room position must be below ${ROOM_POSITION_LIMIT}`);
}

/** The first palette colour no room uses yet; when all are taken, the palette again from the start. */
export function defaultColour(rooms: readonly RoomRecord[]): string {
  const used = new Set(rooms.map((room) => room.colour));
  const free = DEFAULT_ROOM_PALETTE.find((entry) => !used.has(entry.hex));
  return (free ?? DEFAULT_ROOM_PALETTE[rooms.length % DEFAULT_ROOM_PALETTE.length] ?? DEFAULT_ROOM_PALETTE[0]).hex;
}

/** Species cycle bun → bot → shield → ghost → cat, by how many rooms there are. */
export function defaultSpecies(rooms: readonly RoomRecord[]): RoomSpecies {
  return ROOM_SPECIES[rooms.length % ROOM_SPECIES.length] ?? 'bun';
}

/** The body colour clamped into the readable luminance range. */
export function bodyColour(hex: string): { readonly hex: string; readonly adjusted: boolean } {
  return clampBody(hex);
}

/** Warnings, never refusals: a colour near a reserved one (ΔE < 12) or near another room's (ΔE < 10). */
export function colourWarnings(colour: string, rooms: readonly RoomRecord[], self: string | null): RoomWarning[] {
  const reserved = nearReserved(colour).map((hit): RoomWarning => ({
    kind: 'near-reserved', detail: `close to the ${hit.name} colour (ΔE ${hit.deltaE.toFixed(1)})`, room: null,
  }));
  const near = rooms.flatMap((room): RoomWarning[] => {
    if (room.id === self) return [];
    const delta = deltaE2000(colour, room.colour);
    return delta < ROOM_WARN_DELTA_E ? [{ kind: 'near-room', detail: `close to ${room.name} (ΔE ${delta.toFixed(1)})`, room: room.id }] : [];
  });
  return [...reserved, ...near];
}
