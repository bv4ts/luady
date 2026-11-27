import { z } from 'zod';
import {
  HexSchema, HostIdSchema, LIMITS, ProjectMatchSchema, ROOM_KINDS, ROOM_SIZES, ROOM_SPECIES, RoomIdSchema, type RoomDTO,
} from '@luady/shared';
import type { Db, Logger } from '../core/contracts.js';

/** A room as stored: every RoomDTO field but `hostState`, which follows the host's row (rooms/service.ts). */
export type RoomRecord = Omit<RoomDTO, 'hostState'>;

/** The settings row that says config.rooms was imported once; the import never runs again. */
export const ROOMS_SEEDED_KEY = 'rooms_seeded';

/** Positions are moved out of the way by this much in the first pass of a two-pass update. */
export const POSITION_SHIFT = 1_000_000_000;

const RoomRowSchema = z.object({
  id: z.string(), name: z.string(), short: z.string(), kind: z.enum(ROOM_KINDS), host: z.string().nullable(),
  match_json: z.string(), colour: z.string(), accent: z.string(), species: z.enum(ROOM_SPECIES), position: z.number().int(),
  size: z.enum(ROOM_SIZES), created_at: z.string(), updated_at: z.string(),
});

const RecordSchema = z.object({
  id: RoomIdSchema, name: z.string().min(1).max(LIMITS.roomNameMax), short: z.string().min(1).max(LIMITS.roomShortMax),
  kind: z.enum(ROOM_KINDS), host: HostIdSchema.nullable(), match: z.array(ProjectMatchSchema).max(LIMITS.roomMatchesMax),
  colour: HexSchema, accent: HexSchema, species: z.enum(ROOM_SPECIES), position: z.number().int().min(0), size: z.enum(ROOM_SIZES),
  createdAt: z.string(), updatedAt: z.string(),
});

const COLUMNS = 'id, name, short, kind, host, match_json, colour, accent, species, position, size, created_at, updated_at';

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export interface RoomsRepo {
  /** Every room that parses, by position; a row that does not is logged with its id and left out. */
  all(): RoomRecord[];
  get(id: string): RoomRecord | null;
  insert(room: RoomRecord): void;
  /** Writes every field but the id, position and creation time. */
  update(room: RoomRecord): void;
  /** Sets several positions at once in two passes, so a swap or a re-order never trips UNIQUE (position). */
  setPositions(moves: ReadonlyArray<{ readonly id: string; readonly position: number }>, updatedAt: string): void;
  remove(id: string): void;
  /** Host ids whose hosts row is a tombstone (removed): a kept room of such a host reads `hostState: 'removed'`. */
  removedHosts(): ReadonlySet<string>;
  seeded(): boolean;
  markSeeded(): void;
  /** Runs `work` in one transaction. */
  transaction<T>(work: () => T): T;
}

export function createRoomsRepo(db: Db, log: Logger): RoomsRepo {
  const all = db.prepare(`SELECT ${COLUMNS} FROM rooms ORDER BY position`);
  const one = db.prepare(`SELECT ${COLUMNS} FROM rooms WHERE id = ?`);
  const insert = db.prepare(`INSERT INTO rooms (${COLUMNS}) VALUES (@id, @name, @short, @kind, @host, @match, @colour, @accent,
    @species, @position, @size, @createdAt, @updatedAt)`);
  const update = db.prepare(`UPDATE rooms SET name = @name, short = @short, kind = @kind, host = @host, match_json = @match,
    colour = @colour, accent = @accent, species = @species, size = @size, updated_at = @updatedAt WHERE id = @id`);
  const shift = db.prepare('UPDATE rooms SET position = position + ? WHERE id = ?');
  const place = db.prepare('UPDATE rooms SET position = ?, updated_at = ? WHERE id = ?');
  const del = db.prepare('DELETE FROM rooms WHERE id = ?');
  const removed = db.prepare<[string], { name: string }>('SELECT name FROM servers WHERE state = ?');
  const seededRow = db.prepare<[string], { value_json: string }>('SELECT value_json FROM settings WHERE key = ?');
  const markSeeded = db.prepare('INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)');

  function fromRow(raw: unknown): RoomRecord | null {
    const row = RoomRowSchema.safeParse(raw);
    const key = typeof raw === 'object' && raw !== null && 'id' in raw ? String(raw.id) : '?';
    if (!row.success) {
      log.warn({ table: 'rooms', key, issue: row.error.issues[0]?.message }, 'rooms: a row does not parse and is left out');
      return null;
    }
    const r = row.data;
    const record = RecordSchema.safeParse({
      id: r.id, name: r.name, short: r.short, kind: r.kind, host: r.host, match: parseJson(r.match_json), colour: r.colour,
      accent: r.accent, species: r.species, position: r.position, size: r.size, createdAt: r.created_at, updatedAt: r.updated_at,
    });
    if (!record.success) {
      log.warn({ table: 'rooms', key, issue: record.error.issues[0]?.message }, 'rooms: a row does not parse and is left out');
      return null;
    }
    return record.data;
  }

  const params = (room: RoomRecord): Record<string, string | number | null> => ({
    id: room.id, name: room.name, short: room.short, kind: room.kind, host: room.host, match: JSON.stringify(room.match),
    colour: room.colour, accent: room.accent, species: room.species, position: room.position, size: room.size,
    createdAt: room.createdAt, updatedAt: room.updatedAt,
  });

  const setPositions = db.transaction((moves: ReadonlyArray<{ id: string; position: number }>, updatedAt: string) => {
    for (const move of moves) shift.run(POSITION_SHIFT, move.id);
    for (const move of moves) place.run(move.position, updatedAt, move.id);
  });

  return {
    all: () => all.all().flatMap((raw) => fromRow(raw) ?? []),
    get: (id) => {
      const raw = one.get(id);
      return raw === undefined ? null : fromRow(raw);
    },
    insert: (room) => {
      insert.run(params(room));
    },
    update: (room) => {
      update.run(params(room));
    },
    setPositions: (moves, updatedAt) => setPositions(moves, updatedAt),
    remove: (id) => {
      del.run(id);
    },
    removedHosts: () => new Set(removed.all('removed').map((row) => row.name)),
    seeded: () => seededRow.get(ROOMS_SEEDED_KEY) !== undefined,
    markSeeded: () => {
      markSeeded.run(ROOMS_SEEDED_KEY, 'true');
    },
    transaction: (work) => db.transaction(work)(),
  };
}
