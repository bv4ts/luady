import type { ProjectMatch, RoomDTO } from '../rooms.js';

/**
 * Which room a session sits in, as a pure function:
 *
 * 1. the most specific matching project room on the session's host, or on any host;
 * 2. otherwise the host's `server` or `local` home room, as a guest when at least one of its matches could be compared
 *    (the session's project name or cwd that the match reads is known) and none of them fits;
 * 3. otherwise a guest in the host's lowest-position room;
 * 4. otherwise null: not on the map.
 *
 * A path match beats a name match, then the longer literal prefix wins, then the lower position.
 */

interface HostRooms {
  /** The host's server or local room, if any. */
  readonly home: RoomDTO | null;
  /** The host's project rooms. */
  readonly projects: readonly RoomDTO[];
  /** The host's lowest-position room of any kind. */
  readonly first: RoomDTO | null;
}

export interface RoomIndex {
  readonly byHost: ReadonlyMap<string, HostRooms>;
  /** Project rooms with no host: they take sessions from every host. */
  readonly anyHost: readonly RoomDTO[];
  /** Operation count: glob comparisons made through this index (the tests assert it). */
  readonly stats: { globCalls: number };
}

export interface SessionPlace {
  readonly host: string;
  readonly project: string | null;
  readonly cwd: string | null;
}

/** Builds the index once per rooms array. */
export function buildRoomIndex(rooms: readonly RoomDTO[]): RoomIndex {
  const sorted = [...rooms].sort((a, b) => a.position - b.position);
  const groups = new Map<string, { home: RoomDTO | null; projects: RoomDTO[]; first: RoomDTO | null }>();
  const anyHost: RoomDTO[] = [];
  for (const room of sorted) {
    if (room.host === null) {
      if (room.kind === 'project') anyHost.push(room);
      continue;
    }
    const group = groups.get(room.host) ?? { home: null, projects: [], first: null };
    const next = {
      home: group.home ?? (room.kind === 'project' ? null : room),
      projects: room.kind === 'project' ? [...group.projects, room] : group.projects,
      first: group.first ?? room,
    };
    groups.set(room.host, next);
  }
  return { byHost: groups, anyHost, stats: { globCalls: 0 } };
}

/** Matches one glob segment against one text segment: `*` any run, `?` one character, no backtracking blow-up. */
function matchSegment(glob: string, text: string): boolean {
  let g = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    const gc = glob[g];
    if (gc !== undefined && (gc === '?' || gc === text[t]) && gc !== '*') {
      g += 1;
      t += 1;
    } else if (gc === '*') {
      star = g;
      mark = t;
      g += 1;
    } else if (star !== -1) {
      g = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (glob[g] === '*') g += 1;
  return g === glob.length;
}

/**
 * `name` globs match the whole project name. `path` globs match the whole cwd: `*` and `?` never cross `/`, and a
 * trailing `/**` matches the folder and everything below it.
 */
export function globMatch(glob: string, text: string, by: 'name' | 'path'): boolean {
  if (by === 'name') return matchSegment(glob, text);
  const deep = glob.endsWith('/**');
  const base = deep ? glob.slice(0, -3) : glob;
  const globParts = base.split('/');
  const textParts = text.split('/');
  if (deep ? textParts.length < globParts.length : textParts.length !== globParts.length) return false;
  return globParts.every((part, i) => matchSegment(part, textParts[i] ?? ''));
}

/** The literal characters before the first wildcard. */
const literalPrefix = (glob: string): number => {
  const at = glob.search(/[*?]/);
  return at === -1 ? glob.length : at;
};

interface Fit {
  readonly room: RoomDTO;
  readonly path: boolean;
  readonly prefix: number;
}

function bestMatch(room: RoomDTO, s: SessionPlace, ix: RoomIndex): Fit | null {
  let best: Fit | null = null;
  for (const m of room.match) {
    if (!fits(m, s, ix)) continue;
    const fit: Fit = { room, path: m.by === 'path', prefix: literalPrefix(m.glob) };
    if (best === null || better(fit, best)) best = fit;
  }
  return best;
}

/** What a match compares: the cwd for a path glob, the project name for a name glob. */
const textFor = (m: ProjectMatch, s: SessionPlace): string | null => (m.by === 'path' ? s.cwd : s.project);

function fits(m: ProjectMatch, s: SessionPlace, ix: RoomIndex): boolean {
  const text = textFor(m, s);
  if (text === null) return false;
  ix.stats.globCalls += 1;
  return globMatch(m.glob, text, m.by);
}

const better = (a: Fit, b: Fit): boolean => {
  if (a.path !== b.path) return a.path;
  if (a.prefix !== b.prefix) return a.prefix > b.prefix;
  return a.room.position < b.room.position;
};

export function roomOf(s: SessionPlace, ix: RoomIndex): { room: string; guest: boolean } | null {
  const own = ix.byHost.get(s.host);
  let best: Fit | null = null;
  for (const room of [...(own?.projects ?? []), ...ix.anyHost]) {
    const fit = bestMatch(room, s, ix);
    if (fit !== null && (best === null || better(fit, best))) best = fit;
  }
  if (best !== null) return { room: best.room.id, guest: false };
  if (own === undefined) return null;
  if (own.home !== null) {
    const home = own.home;
    // A guest only when at least one match could be compared (its text was known) and none fits.
    const comparable = home.match.some((m) => textFor(m, s) !== null);
    const guest = comparable && bestMatch(home, s, ix) === null;
    return { room: home.id, guest };
  }
  return own.first === null ? null : { room: own.first.id, guest: true };
}
