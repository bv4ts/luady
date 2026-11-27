import type { ProjectMatch, RoomDTO } from '@luady/shared';
import { buildSnapshot, type AgencySnapshot, type SnapshotInput } from '../src/snapshot.js';
import type { Palette } from '../src/types.js';

const EPOCH = '2026-11-21T00:00:00.000Z';

/** A room row as the hub sends it; every field can be overridden. */
export const room = (id: string, position: number, over: Partial<RoomDTO> = {}): RoomDTO => ({
  id, name: `Room ${id}`, short: id.slice(0, 12), kind: 'project', host: null, match: [],
  colour: '#3d7bff', accent: '#9fbdff', species: 'bot', position, size: 'm', hostState: 'ok', createdAt: EPOCH, updatedAt: EPOCH,
  ...over,
});

/** The classic office colours (Open Color), one per classic room: the colours of every classic-map oracle. */
export const CLASSIC_PALETTES = Object.freeze({
  rose: Object.freeze({ base: '#d6336c', accent: '#74b816' }),
  amber: Object.freeze({ base: '#f76707', accent: '#37b24d' }),
  jade: Object.freeze({ base: '#12b886', accent: '#c3fae8' }),
  pv: Object.freeze({ base: '#7c5cff', accent: '#ffd84d' }),
}) satisfies Readonly<Record<string, Palette>>;

export type ClassicId = 'birch' | 'ash' | 'cedar' | 'local';

/** A fixed time for the classic rows' bookkeeping fields: the classic rooms never change. */
const CLASSIC_EPOCH = '1970-01-01T00:00:00.000Z';

const classicRoom = (
  id: ClassicId, position: number, name: string, short: string, palette: Palette, species: RoomDTO['species'], globs: readonly string[],
): RoomDTO => Object.freeze({
  id, name, short, kind: 'server', host: id,
  match: Object.freeze(globs.map((glob) => Object.freeze({ by: 'name' as const, glob }))) as ProjectMatch[],
  colour: palette.base, accent: palette.accent, species, position, size: 'm', hostState: 'ok', createdAt: CLASSIC_EPOCH, updatedAt: CLASSIC_EPOCH,
});

/**
 * The classic four as `RoomDTO`s, in slot order: Orchard on birch (slot 0), Harbor on ash (1), Meadow on
 * cedar (2) and Private Projects on local (3), all of kind `server`. Their globs keep each room's home projects;
 * Private Projects has none, so nothing there is ever a guest.
 */
export const CLASSIC_ROOMS: readonly RoomDTO[] = Object.freeze([
  classicRoom('birch', 0, 'Orchard', 'Orchard', CLASSIC_PALETTES.rose, 'bun', ['orchard*', 'dev_orchard*']),
  classicRoom('ash', 1, 'Harbor', 'Harbor', CLASSIC_PALETTES.amber, 'bot', ['harbor*']),
  classicRoom('cedar', 2, 'Meadow', 'Meadow', CLASSIC_PALETTES.jade, 'shield', ['meadow*']),
  classicRoom('local', 3, 'Private Projects', 'Private', CLASSIC_PALETTES.pv, 'ghost', []),
]);

/** The classic four as RoomDTOs, by id. */
export const classic = (id: ClassicId): RoomDTO => {
  const found = CLASSIC_ROOMS.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no classic room ${id}`);
  return found;
};

const SUBSETS = new Map<string, readonly RoomDTO[]>();

/** The classic rooms of these servers (unknown names and repeats ignored), in slot order; the same set, the same array. */
export const classicRooms = (servers: readonly string[] = CLASSIC_ROOMS.map((r) => r.id)): readonly RoomDTO[] => {
  const wanted = new Set(servers);
  const picked = CLASSIC_ROOMS.filter((r) => wanted.has(r.id));
  const key = picked.map((r) => r.id).join(',');
  const known = SUBSETS.get(key);
  if (known !== undefined) return known;
  const made = Object.freeze(picked);
  SUBSETS.set(key, made);
  return made;
};

/** A snapshot input whose rooms may be left out: then they are the classic rooms of its servers. */
export type ClassicInput = Omit<SnapshotInput, 'rooms'> & { readonly rooms?: readonly RoomDTO[] | undefined };

/** buildSnapshot over the given rooms, or (none given) the classic rooms of the input's servers, empty slots as lots. */
export const classicSnapshot = (input: ClassicInput): AgencySnapshot =>
  buildSnapshot({ ...input, rooms: input.rooms ?? classicRooms(input.servers.map((s) => s.name)) });

/** n rooms at positions 0..n-1, alternating hosts and kinds. */
export const rooms = (n: number): RoomDTO[] =>
  Array.from({ length: n }, (_, i) => room(`site-${String(i).padStart(2, '0')}`, i, {
    kind: i % 3 === 0 ? 'server' : 'project', host: `host-${i % 2}`,
  }));
