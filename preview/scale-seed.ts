import type { RoomImport, RoomSpecies } from '@luady/shared';
import { PREVIEW_ROOMS } from './rooms-seed.ts';
import type { SeedSession } from './seed.ts';

// Data only, like rooms-seed.ts: demo.ts reads this file before it has checked that the build exists.

/**
 * The demo's room counts (`--rooms`): `classic` is the preview's office with its full seed; a number
 * n < 4 is the first n classic rooms (0 = an empty office); n ≥ 4 is the classic four plus `site-05` … `site-n`;
 * `mixed` is 12 rooms on 6 hosts. Every room goes through the real `config.rooms` import.
 */
export type RoomsMode = number | 'classic' | 'mixed';

/** The most rooms `--rooms` takes: well past the 300 rooms the office is tested with at scale. */
export const MAX_DEMO_ROOMS = 1_000;
/** Sessions of a scale seed, whatever the room count (capped at 1,500). */
export const MAX_SCALE_SESSIONS = 1_500;
/** A room of the scale seed holds 0 to 3 sessions (the seed's object budget). */
export const MAX_SESSIONS_PER_ROOM = 3;

/** The two servers `mixed` adds to the classic four (neutral names; their addresses are under `.invalid`). */
export const MIXED_SERVERS: readonly string[] = Object.freeze(['elm', 'pine']);

/** The classic hosts a `site-` room is put on, in turn. */
const SITE_HOSTS = ['birch', 'ash', 'cedar', 'local'] as const;
const SPECIES: readonly RoomSpecies[] = ['bun', 'bot', 'shield', 'ghost', 'cat'];
/** Room colours and accents (Open Color), cycled; no client colour. */
const COLOURS: readonly (readonly [string, string])[] = [
  ['#1c7ed6', '#ffd43b'], ['#ae3ec9', '#63e6be'], ['#f59f00', '#4c6ef5'], ['#0ca678', '#ff8787'],
  ['#e8590c', '#74c0fc'], ['#5c940d', '#f783ac'], ['#1098ad', '#ffa94d'], ['#d6336c', '#a9e34b'],
];
/** The project name each classic room's sessions take (its match accepts them). */
const CLASSIC_PROJECT: Readonly<Record<string, string>> = { birch: 'orchard', ash: 'harbor', cedar: 'meadow', local: 'research' };
const SESSION_SUFFIXES = ['api', 'web', 'docs'] as const;
const STATES: readonly SeedSession['state'][] = ['idle', 'working', 'idle', 'working', 'idle', 'question', 'working', 'idle', 'permission', 'working', 'idle', 'error'];

const pad = (n: number): string => String(n).padStart(2, '0');

/** FNV-1a: the same small number for the same text on every run (no random numbers in a seed). */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function siteRoom(n: number, host: string): RoomImport {
  const id = `site-${pad(n)}`;
  const [colour, accent] = COLOURS[n % COLOURS.length] ?? ['#1c7ed6', '#ffd43b'];
  return {
    id, name: `Site ${pad(n)}`, short: `Site ${pad(n)}`, kind: 'project', host, position: n - 1,
    species: SPECIES[n % SPECIES.length] ?? 'bun', colour, accent, match: [{ by: 'name', glob: `${id}-*` }],
  };
}

/** `mixed`: the classic four, a server room for each added server, and six project rooms across the six hosts. */
function mixedRooms(): RoomImport[] {
  const servers = MIXED_SERVERS.map((host, i): RoomImport => {
    const [colour, accent] = COLOURS[i + 2] ?? ['#1c7ed6', '#ffd43b'];
    const name = host.charAt(0).toUpperCase() + host.slice(1);
    return { id: host, name, short: name, kind: 'server', host, position: 4 + i, species: SPECIES[i] ?? 'bun', colour, accent, match: [] };
  });
  const hosts = [...SITE_HOSTS, ...MIXED_SERVERS];
  const projects = hosts.map((host, i) => siteRoom(7 + i, host));
  return [...PREVIEW_ROOMS, ...servers, ...projects];
}

/** The rooms a mode imports, positions 0 … n-1 (each one unique). */
export function demoRooms(mode: RoomsMode): RoomImport[] {
  if (mode === 'classic') return [...PREVIEW_ROOMS];
  if (mode === 'mixed') return mixedRooms();
  if (!Number.isInteger(mode) || mode < 0 || mode > MAX_DEMO_ROOMS) throw new RangeError(`--rooms takes 0 to ${MAX_DEMO_ROOMS}, classic or mixed`);
  if (mode < PREVIEW_ROOMS.length) return PREVIEW_ROOMS.slice(0, mode);
  const sites: RoomImport[] = [];
  for (let n = PREVIEW_ROOMS.length + 1; n <= mode; n += 1) sites.push(siteRoom(n, SITE_HOSTS[(n - 1) % SITE_HOSTS.length] ?? 'birch'));
  return [...PREVIEW_ROOMS, ...sites];
}

/** The servers a mode adds to the preview's four (only `mixed` adds any). */
export function demoExtraServers(mode: RoomsMode): readonly string[] {
  return mode === 'mixed' ? MIXED_SERVERS : [];
}

/** The project name a room's sessions take: its own glob's prefix for a site room, the room's project for the others. */
function projectOf(room: RoomImport): string {
  if (room.kind === 'project') return room.id;
  return CLASSIC_PROJECT[room.id] ?? room.id;
}

/**
 * The sessions of a scale seed: 0 to 3 per room, chosen by the room's id (the same on every run), named so that the
 * room's own match takes them, on the room's host, at most 1,500 in all. Most are idle or working; a few ask, wait for
 * a permission or failed.
 */
export function scaleSessions(rooms: readonly RoomImport[]): SeedSession[] {
  const sessions: SeedSession[] = [];
  for (const room of rooms) {
    if (room.host === null || room.host === undefined) continue;
    const count = hash(room.id) % (MAX_SESSIONS_PER_ROOM + 1);
    for (let i = 0; i < count && sessions.length < MAX_SCALE_SESSIONS; i += 1) {
      const name = `${projectOf(room)}-${SESSION_SUFFIXES[i] ?? String(i)}`;
      const h = hash(`${room.id}/${name}`);
      sessions.push({ host: room.host, name, state: STATES[h % STATES.length] ?? 'idle', quietMin: 1 + (h % 40) });
    }
  }
  return sessions;
}

/** What the demo seeds for a mode: the classic seed (null) or a scale seed, with its rooms and extra servers. */
export interface DemoSeed {
  readonly rooms: readonly RoomImport[];
  readonly servers: readonly string[];
  /** null: the preview's classic sessions and its board, notes and Jira; a list: the office only. */
  readonly sessions: readonly SeedSession[] | null;
}

export function demoSeed(mode: RoomsMode): DemoSeed {
  const rooms = demoRooms(mode);
  return { rooms, servers: demoExtraServers(mode), sessions: mode === 'classic' ? null : scaleSessions(rooms) };
}
