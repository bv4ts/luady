import {
  LIMITS, LOCAL_HOST_ID, defaultAccent, gridFor, slotCountOf, type GridDTO, type ProjectDTO, type RoomCreateBody, type RoomDTO,
  type RoomDeleteBody, type RoomImport, type RoomPreviewBody, type RoomPreviewDTO, type RoomUpdateBody, type RoomWarning,
  type RoomWriteDTO, type RoomsDTO, type SessionDTO,
} from '@luady/shared';
import type { Clock, Db, EventBus, Fleet, Logger, RoomsService } from '../core/contracts.js';
import { NotFoundError } from '../core/errors.js';
import { isoNow } from '../core/time.js';
import { officeNameIn } from '../library/offices.js';
import { createCascade, type CascadeResult } from './cascade.js';
import { RoomConflictError, RoomInvalidError } from './errors.js';
import { PREVIEW_ID, previewRoom } from './preview.js';
import { createRoomsRepo, type RoomRecord } from './repo.js';
import { writeRoomsAuto } from './rooms-file.js';
import {
  bodyColour, checkHost, checkMatches, checkNameFree, checkPositionBound, cleanText, colourWarnings, defaultColour, defaultHost,
  defaultSpecies, shortFor, slugFor,
} from './validate.js';

/** The rooms service's methods, added to the `RoomsService` interface by declaration merging. */
declare module '../core/contracts.js' {
  interface RoomsService {
    get(id: string): RoomDTO | null;
    create(body: RoomCreateBody): RoomWriteDTO;
    /** 409 `room_conflict` when `expectUpdatedAt` is not the room's `updatedAt` any more. */
    update(id: string, body: RoomUpdateBody): RoomWriteDTO;
    /** A permutation of every room id; positions become 0..n-1. */
    order(ids: readonly string[]): RoomsDTO;
    /** Into a free slot inside the grid, or a swap with the slot's occupant. */
    move(id: string, position: number): RoomsDTO;
    /** `verifyPin` runs (and must resolve) only when a Jira site would be disconnected. */
    remove(id: string, body: RoomDeleteBody, verifyPin: (pin: string | undefined) => Promise<void>): Promise<void>;
    preview(body: RoomPreviewBody): RoomPreviewDTO;
    /** The rooms whose host is `host` (what a host removal touches). */
    roomsOfHost(host: string): RoomDTO[];
    /**
     * A host's removal (after its tombstone is written and its PIN checked): `delete` deletes its rooms with their
     * links and Jira sites; `keep` keeps them, readable as `hostState: 'removed'` and still editable.
     */
    deleteRoomsOfHost(host: string, mode: 'delete' | 'keep'): void;
    /** The name the owner knows: a room's name for a room id, a host's home-room name for a host id, else the key. */
    officeName(key: string): string;
    /** Imports config.rooms with their ids and positions, each through the same checks; returns how many went in. */
    importRooms(rooms: readonly RoomImport[]): number;
    seeded(): boolean;
    markSeeded(): void;
    stop(): void;
  }
}

export interface RoomsDeps {
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  fleet: Pick<Fleet, 'hasServer' | 'hasLocal' | 'hostInfo' | 'servers'>;
  /** Live sessions and known projects, read at call time: the preview and the overlap warnings. */
  sessions?: () => readonly SessionDTO[];
  projects?: () => readonly ProjectDTO[];
  /** Where ROOMS.auto.md is written after every change; none = not written. */
  brainDir?: string;
  /** `rooms.changed` goes out at most once per this many ms (4 a second). */
  changedMinMs?: number;
}

export const ROOMS_CHANGED_MIN_MS = 250;

const SQLITE_UNIQUE = /UNIQUE constraint failed: (.+)$/;

/** A write the database refused although the checks passed (two writes raced): the same coded 409 as the check. */
function asConflict(err: unknown): unknown {
  const which = err instanceof Error ? SQLITE_UNIQUE.exec(err.message)?.[1] ?? null : null;
  if (which === null) return err;
  if (which.includes('position')) return new RoomConflictError('position_taken', 'That slot is taken');
  if (which.includes('idx_rooms_home')) return new RoomConflictError('home_room_exists', 'That host already has its room');
  if (which.includes('idx_rooms_name')) return new RoomConflictError('name_taken', 'A room already has that name');
  return new RoomConflictError('room_exists', 'A room with that id exists');
}

function lowestFree(rooms: readonly RoomRecord[]): number {
  const taken = new Set(rooms.map((room) => room.position));
  let slot = 0;
  while (taken.has(slot)) slot += 1;
  return slot;
}

function gridOf(rooms: readonly RoomRecord[]): GridDTO {
  const slotCount = slotCountOf(rooms.map((room) => room.position));
  return { slotCount, ...gridFor(slotCount) };
}

export function createRoomsService(deps: RoomsDeps): RoomsService {
  const repo = createRoomsRepo(deps.db, deps.log);
  const cascade = createCascade(deps.db, (id) => repo.remove(id));
  const minMs = deps.changedMinMs ?? ROOMS_CHANGED_MIN_MS;
  let lastEmitMs = Number.NEGATIVE_INFINITY;
  let trailing: ReturnType<typeof setTimeout> | null = null;

  const toDto = (room: RoomRecord, removed: ReadonlySet<string>): RoomDTO =>
    ({ ...room, hostState: room.host !== null && removed.has(room.host) ? 'removed' : 'ok' });

  function list(): RoomsDTO {
    const rooms = repo.all();
    const removed = repo.removedHosts();
    return { items: rooms.map((room) => toDto(room, removed)), grid: gridOf(rooms) };
  }

  function emitNow(): void {
    lastEmitMs = deps.clock.now().getTime();
    const at = isoNow(deps.clock);
    const { items } = list();
    deps.bus.emit('rooms.changed', { rooms: items, at });
    if (deps.brainDir !== undefined) {
      writeRoomsAuto(deps.brainDir, items, at).catch((err: unknown) => deps.log.warn({ err }, 'rooms: ROOMS.auto.md not written'));
    }
  }

  /** At most one `rooms.changed` per window: at once when the last one is old enough, else one at the window's end. */
  function changed(): void {
    if (trailing !== null) return;
    const since = deps.clock.now().getTime() - lastEmitMs;
    if (since >= minMs) {
      emitNow();
      return;
    }
    trailing = setTimeout(() => {
      trailing = null;
      // A timer must never throw: once the hub is stopping, the database is closed.
      try {
        emitNow();
      } catch (err) {
        deps.log.warn({ err }, 'rooms: the delayed rooms.changed was not sent');
      }
    }, minMs - since);
    trailing.unref();
  }

  /** An ISO time strictly after `previous`, so every write moves `updatedAt` (the stale-write check needs it). */
  function stampAfter(previous: string | null): string {
    const now = deps.clock.now().getTime();
    const last = previous === null ? Number.NEGATIVE_INFINITY : Date.parse(previous);
    return new Date(Number.isFinite(last) && now <= last ? last + 1 : now).toISOString();
  }

  /** The projects folders a path match must lie in: the host's, or every host's for a project room with no host. */
  function rootsFor(host: string | null): string[] {
    const ids = host === null ? deps.fleet.servers().map((server) => server.name) : [host];
    return ids.flatMap((id) => deps.fleet.hostInfo(id)?.projectsRoot ?? []);
  }

  function warningsFor(room: RoomDTO, rooms: readonly RoomRecord[]): RoomWarning[] {
    const overlaps = deps.projects === undefined ? [] : previewRoom(
      { kind: room.kind, host: room.host, match: room.match, id: room.id }, room, rooms.map((r) => toDto(r, new Set())), [], deps.projects(),
    ).overlaps;
    return [
      ...colourWarnings(room.colour, rooms, room.id),
      ...overlaps.map((overlap): RoomWarning => ({ kind: 'overlap', detail: `also matches ${overlap.projects.join(', ')}`, room: overlap.room })),
    ];
  }

  function writeResult(id: string, adjusted: RoomWriteDTO['adjusted']): RoomWriteDTO {
    const { items } = list();
    const room = items.find((item) => item.id === id);
    if (room === undefined) throw new NotFoundError(`No room ${id}`);
    return { room, adjusted, warnings: warningsFor(room, repo.all()) };
  }

  /** The position of a new room: the lowest free slot, or the asked one when it is free and inside the grid (or the lowest free). */
  function positionFor(asked: number | undefined, rooms: readonly RoomRecord[], anywhere: boolean): number {
    const lowest = lowestFree(rooms);
    if (asked === undefined) return lowest;
    checkPositionBound(asked);
    if (rooms.some((room) => room.position === asked)) throw new RoomConflictError('position_taken', `Slot ${asked} is taken`);
    if (!anywhere && asked >= gridOf(rooms).capacity && asked !== lowest) {
      throw new RoomInvalidError('position_outside_grid', `Slot ${asked} is outside the office; the next free slot is ${lowest}`);
    }
    return asked;
  }

  function insertRoom(body: RoomCreateBody, opts: { readonly anywhere: boolean }): RoomWriteDTO {
    const rooms = repo.all();
    const name = cleanText(body.name, LIMITS.roomNameMax, 'name');
    checkNameFree(name, rooms, null);
    const host = defaultHost(body.kind, body.host);
    checkHost(body.kind, host, deps.fleet, rooms, null);
    const match = body.match ?? [];
    checkMatches(body.kind, match, rootsFor(host));
    if (body.id !== undefined && rooms.some((room) => room.id === body.id)) throw new RoomConflictError('room_exists', `A room ${body.id} exists`);
    const id = body.id ?? slugFor(name, new Set(rooms.map((room) => room.id)));
    const position = positionFor(body.position, rooms, opts.anywhere);
    const colour = bodyColour(body.colour ?? defaultColour(rooms));
    const at = stampAfter(null);
    const record: RoomRecord = {
      id, name, short: body.short === undefined ? shortFor(name) : cleanText(body.short, LIMITS.roomShortMax, 'short name'),
      kind: body.kind, host, match, colour: colour.hex, accent: body.accent ?? defaultAccent(colour.hex),
      species: body.species ?? defaultSpecies(rooms), position, size: 'm', createdAt: at, updatedAt: at,
    };
    try {
      repo.insert(record);
    } catch (err) {
      throw asConflict(err);
    }
    deps.log.info({ room: id, kind: record.kind, host, position }, 'rooms: created');
    changed();
    return writeResult(id, { colour: colour.adjusted, accent: false });
  }

  function update(id: string, body: RoomUpdateBody): RoomWriteDTO {
    const rooms = repo.all();
    const current = rooms.find((room) => room.id === id);
    if (current === undefined) throw new NotFoundError(`No room ${id}`);
    if (body.expectUpdatedAt !== current.updatedAt) {
      throw new RoomConflictError('room_conflict', `${current.name} was changed elsewhere; load it again`);
    }
    const name = body.name === undefined ? current.name : cleanText(body.name, LIMITS.roomNameMax, 'name');
    if (body.name !== undefined) checkNameFree(name, rooms, id);
    const kind = body.kind ?? current.kind;
    const asked = body.host === undefined ? current.host : body.host;
    const host = kind === 'local' && asked === null ? LOCAL_HOST_ID : asked;
    const match = body.match ?? current.match;
    // A kept room of a removed host stays editable: its host is checked only when its kind, host or matches change.
    if (body.kind !== undefined || body.host !== undefined || body.match !== undefined) {
      checkHost(kind, host, deps.fleet, rooms, id);
      checkMatches(kind, match, rootsFor(host));
    }
    const colour = body.colour === undefined ? { hex: current.colour, adjusted: false } : bodyColour(body.colour);
    const next: RoomRecord = {
      ...current, name, kind, host, match, colour: colour.hex, accent: body.accent ?? current.accent,
      short: body.short === undefined ? (body.name === undefined ? current.short : shortFor(name)) : cleanText(body.short, LIMITS.roomShortMax, 'short name'),
      species: body.species ?? current.species, updatedAt: stampAfter(current.updatedAt),
    };
    try {
      repo.update(next);
    } catch (err) {
      throw asConflict(err);
    }
    changed();
    return writeResult(id, { colour: colour.adjusted, accent: false });
  }

  function order(ids: readonly string[]): RoomsDTO {
    const rooms = repo.all();
    const known = new Set(rooms.map((room) => room.id));
    if (ids.length !== rooms.length || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) {
      throw new RoomInvalidError('not_a_permutation', 'The order must name every room exactly once');
    }
    const at = new Map(rooms.map((room) => [room.id, room.position] as const));
    const moves = ids.flatMap((id, position) => (at.get(id) === position ? [] : [{ id, position }]));
    if (moves.length > 0) {
      repo.setPositions(moves, stampAfter(null));
      changed();
    }
    return list();
  }

  function move(id: string, position: number): RoomsDTO {
    const rooms = repo.all();
    const room = rooms.find((r) => r.id === id);
    if (room === undefined) throw new NotFoundError(`No room ${id}`);
    checkPositionBound(position);
    if (room.position === position) return list();
    const occupant = rooms.find((r) => r.position === position);
    if (occupant === undefined && position >= gridOf(rooms).capacity && position !== lowestFree(rooms)) {
      throw new RoomInvalidError('position_outside_grid', `Slot ${position} is outside the office`);
    }
    const moves = occupant === undefined ? [{ id, position }] : [{ id, position }, { id: occupant.id, position: room.position }];
    repo.setPositions(moves, stampAfter(null));
    changed();
    return list();
  }

  function announce(result: CascadeResult): void {
    const at = isoNow(deps.clock);
    if (result.links) deps.bus.emit('links.changed', { at });
    for (const room of result.jira) deps.bus.emit('jira.changed', { room, at });
    if (result.jira.length > 0) deps.bus.emit('accounts.changed', { at });
    if (result.removed.length > 0) changed();
  }

  function preview(body: RoomPreviewBody): RoomPreviewDTO {
    const rooms = list().items;
    const existing = body.id === undefined ? undefined : rooms.find((room) => room.id === body.id);
    const base: RoomDTO = existing ?? {
      id: PREVIEW_ID, name: 'preview', short: 'preview', kind: body.kind, host: body.host, match: body.match, colour: '#000000',
      accent: '#000000', species: 'bun', position: lowestFree(repo.all()), size: 'm', hostState: 'ok', createdAt: '', updatedAt: '',
    };
    const candidate: RoomDTO = { ...base, kind: body.kind, host: body.host, match: body.match };
    return previewRoom(body, candidate, rooms, deps.sessions?.() ?? [], deps.projects?.() ?? []);
  }

  function officeName(key: string): string {
    return officeNameIn(list().items, key);
  }

  function importRooms(imports: readonly RoomImport[]): number {
    let added = 0;
    for (const room of [...imports].sort((a, b) => a.position - b.position)) {
      try {
        insertRoom(room, { anywhere: true });
        added += 1;
      } catch (err) {
        deps.log.warn({ room: room.id, err: err instanceof Error ? err.message : String(err) }, 'rooms: a config room was not imported');
      }
    }
    return added;
  }

  return {
    list,
    get: (id) => list().items.find((room) => room.id === id) ?? null,
    create: (body) => insertRoom(body, { anywhere: false }),
    update,
    order,
    move,
    async remove(id, body, verifyPin) {
      const rooms = repo.all();
      const room = rooms.find((r) => r.id === id);
      if (room === undefined) throw new NotFoundError(`No room ${id}`);
      const result = await cascade.removeRoom(room, body, rooms, verifyPin);
      deps.log.info({ room: id, links: body.links, jira: body.jira }, 'rooms: removed');
      announce(result);
    },
    preview,
    roomsOfHost: (host) => list().items.filter((room) => room.host === host),
    deleteRoomsOfHost(host, mode) {
      const rooms = repo.all().filter((room) => room.host === host);
      if (rooms.length === 0) return;
      if (mode === 'keep') {
        changed();
        return;
      }
      announce(cascade.removeAll(rooms));
      deps.log.info({ host, rooms: rooms.length }, 'rooms: removed with their host');
    },
    officeName,
    importRooms,
    seeded: () => repo.seeded(),
    markSeeded: () => repo.markSeeded(),
    stop() {
      if (trailing !== null) clearTimeout(trailing);
      trailing = null;
    },
  };
}
