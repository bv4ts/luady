import {
  LIMITS, RoomCreateBodySchema, RoomDeleteBodySchema, RoomMoveBodySchema, RoomOrderBodySchema, RoomPreviewBodySchema, RoomUpdateBodySchema,
  buildRoomIndex, clampBody, defaultAccent, globMatch, gridFor, isNewRoomId, roomOf, slotCountOf,
  type RoomDTO, type RoomKind, type RoomPreviewDTO, type RoomsDTO, type RoomWriteDTO, type SessionDTO, type WsServerMessage,
} from '@luady/shared';
import type { z } from 'zod';
import { defaultColour, defaultSpecies } from '../../src/features/rooms/room-form.js';
import { DEMO_ROOMS } from '../fixtures.js';

/**
 * The rooms routes of the pretend hub, after packages/hub/src/rooms/service.ts: the classic four to
 * start with, the same answers and refusal codes, and `rooms.changed` pushed after every change. Null = not a rooms route.
 */
export interface RoomRoutes {
  list(): RoomsDTO;
  route(method: string, path: string, body: unknown): Response | null;
}

export interface RoomRoutesDeps {
  readonly push: (message: WsServerMessage) => void;
  /** The servers the pretend fleet reaches (every one an SSH server). */
  readonly hosts: readonly string[];
  /** The live sessions, for "This room will hold…". */
  readonly sessions: () => readonly SessionDTO[];
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const refuse = (status: number, code: string, message: string): Response => json({ error: { code, message } }, status);
const invalid = (error: z.ZodError): Response => refuse(400, 'validation', error.issues[0]?.message ?? 'Invalid request');
const fold = (name: string): string => name.normalize('NFC').trim().toLocaleLowerCase('und');

/** The short name: the name when it fits, else its first word, cut to fit (as the hub makes it). */
const shortFor = (name: string): string => (name.length <= LIMITS.roomShortMax ? name : (name.split(/\s+/)[0] ?? name).slice(0, LIMITS.roomShortMax));

/** A new room's id from its name: an ASCII slug, `-2`, `-3`, … when it is taken or reserved. */
function slugFor(name: string, taken: ReadonlySet<string>): string {
  const dashed = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const base = (/^[a-z]/.test(dashed) ? dashed : `room-${dashed}`).slice(0, 28).replace(/-+$/, '');
  const fine = (id: string): boolean => isNewRoomId(id) && !taken.has(id);
  if (fine(base)) return base;
  for (let n = 2; ; n += 1) if (fine(`${base}-${n}`)) return `${base}-${n}`;
}

const lowestFree = (rooms: readonly RoomDTO[]): number => {
  const taken = new Set(rooms.map((room) => room.position));
  let slot = 0;
  while (taken.has(slot)) slot += 1;
  return slot;
};

const capacityOf = (rooms: readonly RoomDTO[]): number => gridFor(slotCountOf(rooms.map((room) => room.position))).capacity;

export function createRoomRoutes({ push, hosts, sessions }: RoomRoutesDeps): RoomRoutes {
  let rooms: readonly RoomDTO[] = DEMO_ROOMS;
  let lastStamp = 0;
  /** Strictly later on every write, so the stale-write check always sees a change. */
  const stamp = (): string => {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return new Date(lastStamp).toISOString();
  };
  const find = (id: string): RoomDTO | undefined => rooms.find((room) => room.id === id);
  const gone = (id: string): Response => refuse(404, 'not_found', `No room ${id}`);

  const list = (): RoomsDTO => {
    const items = rooms.toSorted((a, b) => a.position - b.position);
    const slotCount = slotCountOf(items.map((room) => room.position));
    return { items, grid: { slotCount, ...gridFor(slotCount) } };
  };
  const changed = (): void => push({ type: 'rooms.changed', rooms: list().items, at: new Date().toISOString() });
  const written = (room: RoomDTO, adjusted: boolean): Response => {
    changed();
    const answer: RoomWriteDTO = { room, adjusted: { colour: adjusted, accent: false }, warnings: [] };
    return json(answer);
  };

  /** The hub's checks of a room's name, kind, host and matches; null when they pass. */
  function refusal(name: string, kind: RoomKind, host: string | null, matches: number, self: string | null): Response | null {
    if (fold(name) === fold('HQ') || rooms.some((room) => room.id !== self && fold(room.name) === fold(name))) {
      return refuse(409, 'name_taken', `A room is already called ${JSON.stringify(name)}`);
    }
    if (kind === 'local') return refuse(400, 'validation', 'A room for this computer needs this computer set up as a host');
    if (kind === 'server' && (host === null || !hosts.includes(host))) {
      return refuse(400, 'validation', `A server room needs a server the hub reaches over SSH${host === null ? '' : `; ${host} is not one`}`);
    }
    if (host !== null && !hosts.includes(host)) return refuse(400, 'validation', `Unknown host: ${host}`);
    if (kind === 'project' && matches === 0) return refuse(400, 'validation', 'A project room needs at least one match');
    if (kind !== 'project' && rooms.some((room) => room.id !== self && room.kind !== 'project' && room.host === host)) {
      return refuse(409, 'home_room_exists', `${host ?? 'This host'} already has its room`);
    }
    return null;
  }

  function create(raw: unknown): Response {
    const parsed = RoomCreateBodySchema.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const body = parsed.data;
    const host = body.host ?? null;
    const match = body.match ?? [];
    const problem = refusal(body.name, body.kind, host, match.length, null);
    if (problem !== null) return problem;
    if (body.id !== undefined && find(body.id) !== undefined) return refuse(409, 'room_exists', `A room ${body.id} exists`);
    const lowest = lowestFree(rooms);
    const position = body.position ?? lowest;
    if (rooms.some((room) => room.position === position)) return refuse(409, 'position_taken', `Slot ${position} is taken`);
    if (position >= capacityOf(rooms) && position !== lowest) {
      return refuse(400, 'position_outside_grid', `Slot ${position} is outside the office; the next free slot is ${lowest}`);
    }
    const colour = clampBody(body.colour ?? defaultColour(rooms));
    const at = stamp();
    const room: RoomDTO = {
      id: body.id ?? slugFor(body.name, new Set(rooms.map((r) => r.id))), name: body.name, short: body.short ?? shortFor(body.name),
      kind: body.kind, host, match, colour: colour.hex, accent: body.accent ?? defaultAccent(colour.hex),
      species: body.species ?? defaultSpecies(rooms), position, size: 'm', hostState: 'ok', createdAt: at, updatedAt: at,
    };
    rooms = [...rooms, room];
    return written(room, colour.adjusted);
  }

  function update(id: string, raw: unknown): Response {
    const current = find(id);
    if (current === undefined) return gone(id);
    const parsed = RoomUpdateBodySchema.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const body = parsed.data;
    if (body.expectUpdatedAt !== current.updatedAt) return refuse(409, 'room_conflict', `${current.name} was changed elsewhere; load it again`);
    const next = {
      name: body.name ?? current.name, kind: body.kind ?? current.kind,
      host: body.host === undefined ? current.host : body.host, match: body.match ?? current.match,
    };
    const placed = body.kind !== undefined || body.host !== undefined || body.match !== undefined;
    const problem = refusal(next.name, placed ? next.kind : 'project', placed ? next.host : null, placed ? next.match.length : 1, id);
    if (problem !== null) return problem;
    const colour = body.colour === undefined ? { hex: current.colour, adjusted: false } : clampBody(body.colour);
    const room: RoomDTO = {
      ...current, ...next, colour: colour.hex, accent: body.accent ?? current.accent, species: body.species ?? current.species,
      short: body.short ?? (body.name === undefined ? current.short : shortFor(next.name)), updatedAt: stamp(),
    };
    rooms = rooms.map((r) => (r.id === id ? room : r));
    return written(room, colour.adjusted);
  }

  /** New positions for some rooms, each moved room stamped; `rooms.changed` when anything moved. */
  function place(moves: ReadonlyMap<string, number>): Response {
    const moved = rooms.filter((room) => moves.has(room.id) && moves.get(room.id) !== room.position);
    if (moved.length > 0) {
      const at = stamp();
      rooms = rooms.map((room) => (moved.includes(room) ? { ...room, position: moves.get(room.id) ?? room.position, updatedAt: at } : room));
      changed();
    }
    return json(list());
  }

  function order(raw: unknown): Response {
    const parsed = RoomOrderBodySchema.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const { ids } = parsed.data;
    if (ids.length !== rooms.length || new Set(ids).size !== ids.length || !ids.every((id) => find(id) !== undefined)) {
      return refuse(400, 'not_a_permutation', 'The order must name every room exactly once');
    }
    return place(new Map(ids.map((id, position) => [id, position] as const)));
  }

  function move(id: string, raw: unknown): Response {
    const room = find(id);
    if (room === undefined) return gone(id);
    const parsed = RoomMoveBodySchema.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const { position } = parsed.data;
    const occupant = rooms.find((r) => r.position === position && r.id !== id);
    if (occupant === undefined && position >= capacityOf(rooms) && position !== lowestFree(rooms)) {
      return refuse(400, 'position_outside_grid', `Slot ${position} is outside the office`);
    }
    return place(new Map([[id, position], ...(occupant === undefined ? [] : [[occupant.id, room.position] as const])]));
  }

  function remove(id: string, raw: unknown): Response {
    if (find(id) === undefined) return gone(id);
    const parsed = RoomDeleteBodySchema.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const to = parsed.data.to;
    if (to !== undefined && (to === id || find(to) === undefined)) return refuse(400, 'move_target', 'Pick another room for the links and the Jira board');
    rooms = rooms.filter((room) => room.id !== id);
    changed();
    return json({ ok: true });
  }

  /** "This room will hold…": the live sessions and projects it would take, and the other rooms matching them too. */
  function preview(raw: unknown): Response {
    const parsed = RoomPreviewBodySchema.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const body = parsed.data;
    const base = (body.id === undefined ? undefined : find(body.id)) ?? { ...DEMO_ROOMS[0]!, id: ' preview', position: lowestFree(rooms) };
    const candidate: RoomDTO = { ...base, kind: body.kind, host: body.host, match: body.match };
    const others = rooms.filter((room) => room.id !== candidate.id);
    const index = buildRoomIndex([...others, candidate]);
    const live = sessions().filter((s) => s.origin !== 'system' && s.state !== 'ended');
    const taken = live.filter((s) => {
      const at = roomOf(s, index);
      return at !== null && at.room === candidate.id && !at.guest;
    });
    const label = (s: SessionDTO): string => `${s.host}/${s.project ?? ''}`;
    const fits = (room: RoomDTO, s: SessionDTO): boolean => (room.host === s.host || (room.kind === 'project' && room.host === null))
      && s.project !== null && room.match.some((m) => m.by === 'name' && globMatch(m.glob, s.project ?? '', 'name'));
    const overlaps = others
      .map((room) => ({ room: room.id, projects: [...new Set(live.filter((s) => fits(candidate, s) && fits(room, s)).map(label))] }))
      .filter((overlap) => overlap.projects.length > 0);
    const answer: RoomPreviewDTO = { sessions: taken.map((s) => s.id), projects: [...new Set(taken.filter((s) => s.project !== null).map(label))], overlaps };
    return json(answer);
  }

  return {
    list,
    route(method, path, body) {
      if (path === '/api/rooms') return method === 'GET' ? json(list()) : method === 'POST' ? create(body) : null;
      if (method === 'POST' && path === '/api/rooms/order') return order(body);
      if (method === 'POST' && path === '/api/rooms/preview') return preview(body);
      const one = /^\/api\/rooms\/([^/]+)(\/move|\/delete)?$/.exec(path);
      if (one === null) return null;
      const id = decodeURIComponent(one[1] ?? '');
      if (method === 'PUT' && one[2] === undefined) return update(id, body);
      if (method === 'POST' && one[2] === '/move') return move(id, body);
      if (method === 'POST' && one[2] === '/delete') return remove(id, body);
      return null;
    },
  };
}
