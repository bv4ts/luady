import { DESK_CAPACITY, deskModeFor, type DeskMode } from './desks.js';

/** sessionId → desk index within its room. */
export type SeatMap = Readonly<Record<string, number>>;
export interface SeatInput { readonly id: string; readonly room: string }
export interface SeatResult {
  readonly seats: SeatMap;
  readonly modes: Readonly<Record<string, DeskMode>>;
  readonly overflow: Readonly<Record<string, readonly string[]>>;
}

interface RoomSeats { readonly room: string; readonly mode: DeskMode; readonly seats: readonly (readonly [string, number])[]; readonly overflow: readonly string[] }

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Session ids per room, each id once (first room wins), sorted ascending. */
const groupByRoom = (sessions: readonly SeatInput[]): ReadonlyMap<string, readonly string[]> => {
  const seen = new Set<string>();
  const groups = new Map<string, string[]>();
  sessions.forEach(({ id, room }) => {
    if (seen.has(id)) return;
    seen.add(id);
    const list = groups.get(room);
    if (list === undefined) groups.set(room, [id]);
    else list.push(id);
  });
  return new Map([...groups].map(([room, ids]) => [room, ids.toSorted(byId)]));
};

const previousIndex = (previous: SeatMap, id: string): number | undefined => (Object.hasOwn(previous, id) ? previous[id] : undefined);

/**
 * One room: everyone keeps a desk number that is still valid and not claimed by a lower id; then sessions that had a
 * desk but lost it, then newcomers, take the lowest free numbers in id order. Whoever is left over overflows.
 */
const seatRoom = (room: string, ids: readonly string[], previous: SeatMap): RoomSeats => {
  const mode = deskModeFor(ids.length);
  const capacity = DESK_CAPACITY[mode];
  const kept = new Map<number, string>();
  ids.forEach((id) => {
    const p = previousIndex(previous, id);
    if (p !== undefined && Number.isInteger(p) && p >= 0 && p < capacity && !kept.has(p)) kept.set(p, id);
  });
  const keptIds = new Set(kept.values());
  const waiting = ids.filter((id) => !keptIds.has(id));
  const queue = [...waiting.filter((id) => previousIndex(previous, id) !== undefined), ...waiting.filter((id) => previousIndex(previous, id) === undefined)];
  const free = Array.from({ length: capacity }, (_, i) => i).filter((i) => !kept.has(i));
  const placed = queue.slice(0, free.length).map((id, i) => [id, free[i] ?? 0] as const);
  const seats = [...[...kept].map(([index, id]) => [id, index] as const), ...placed];
  return { room, mode, seats, overflow: queue.slice(free.length).toSorted(byId) };
};

/** Gives every session a desk number in its room, keeping earlier numbers wherever the room's arrangement allows. */
export function assignSeats(sessions: readonly SeatInput[], previous: SeatMap): SeatResult {
  const rooms = [...groupByRoom(sessions)].map(([room, ids]) => seatRoom(room, ids, previous));
  return Object.freeze({
    seats: Object.freeze(Object.fromEntries(rooms.flatMap((r) => r.seats))),
    modes: Object.freeze(Object.fromEntries(rooms.map((r) => [r.room, r.mode]))),
    overflow: Object.freeze(Object.fromEntries(rooms.map((r) => [r.room, Object.freeze([...r.overflow])]))),
  });
}
