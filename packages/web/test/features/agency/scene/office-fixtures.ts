import { buildSnapshot, type AgencySnapshot, type SeatMap } from '@luady/office';
import type { HostId, LuadyStatusDTO, RoomDTO, ServerDTO, SessionDTO } from '@luady/shared';
import { DEFAULT_ROOM_PALETTE, lightenHex } from '@luady/shared/pure';
import { classicRoomDtos } from '../../../room-fixtures.js';

export const NOW = Date.parse('2026-11-14T12:00:00.000Z');

export const server = (name: HostId, over: Partial<ServerDTO> = {}): ServerDTO => ({
  name, host: `${name}.example`, status: 'online', lastSeenAt: new Date(NOW).toISOString(), claudeVersion: '2.1.0', kitVersion: '1.0.0',
  sysinfo: { load1: 1, load5: 1, mem_total_kb: 8_000_000, mem_avail_kb: 4_000_000, disk_free_kb: 50 * 1024 * 1024, uptime_s: 3600 },
  kind: 'ssh', projectsRoot: null, homeDir: null, terminal: true,
  ...over,
});

export const ALL_SERVERS: readonly ServerDTO[] = [server('cedar'), server('birch'), server('ash'), server('local')];

/** A registered owner session working right now; the host is the part of the id before the first ':'. */
export const session = (id: string, over: Partial<SessionDTO> = {}): SessionDTO => ({
  id, host: (id.split(':')[0] ?? 'birch') as HostId, target: 'main:0.1', claudeSessionId: null, cwd: null, project: null,
  displayName: `name of ${id}`, state: 'working', origin: 'owner', registered: true, lastEventAt: new Date(NOW).toISOString(),
  turnStartedAt: null, pendingQid: null, unexpectedEnd: false, ...over,
});

/** `count` sessions on one host: 'birch:s00', 'birch:s01', … */
export const many = (host: string, count: number, over: Partial<SessionDTO> = {}): SessionDTO[] =>
  Array.from({ length: count }, (_, i) => session(`${host}:s${String(i).padStart(2, '0')}`, over));

export interface SnapOptions {
  readonly servers?: readonly ServerDTO[];
  readonly previous?: AgencySnapshot | null;
  readonly luady?: LuadyStatusDTO | null;
  readonly helpers?: Readonly<Record<string, number>>;
  readonly contextPct?: Readonly<Record<string, number | null>>;
  readonly jiraRooms?: readonly string[];
}

const EPOCH = '1970-01-01T00:00:00.000Z';

/** One room row: a server room of its own host unless told otherwise. */
export const room = (id: string, position: number, over: Partial<RoomDTO> = {}): RoomDTO => ({
  id, name: id, short: id, kind: 'server', host: id, match: [], colour: '#3d7bff', accent: '#9fbdff', species: 'bun',
  position, size: 'm', hostState: 'ok', createdAt: EPOCH, updatedAt: EPOCH, ...over,
});

/** The classic four as rows, in the classic colours. */
export const CLASSIC: readonly RoomDTO[] = [
  room('birch', 0, { name: 'Orchard', short: 'Orchard', colour: '#d6336c', accent: '#74b816', species: 'bun' }),
  room('ash', 1, { name: 'Harbor', short: 'Harbor', colour: '#f76707', accent: '#37b24d', species: 'bot' }),
  room('cedar', 2, { name: 'Meadow', short: 'Meadow', colour: '#12b886', accent: '#c3fae8', species: 'shield' }),
  room('local', 3, { name: 'Private Projects', short: 'Private', colour: '#7c5cff', accent: '#ffd84d', species: 'ghost' }),
];

const SPECIES_CYCLE: readonly RoomDTO['species'][] = ['bun', 'bot', 'shield', 'ghost', 'cat'];

/**
 * `n` rooms as the demo seeds them: below 4 the first n classic rooms, from 4 the classic four plus
 * site-05 … site-n in the default colours, the species cycling.
 */
export const roomsOf = (n: number): readonly RoomDTO[] => {
  if (n <= 4) return CLASSIC.slice(0, Math.max(0, n));
  return [...CLASSIC, ...Array.from({ length: n - 4 }, (_, k) => {
    const id = `site-${String(k + 5).padStart(2, '0')}`;
    const colour = DEFAULT_ROOM_PALETTE[k % DEFAULT_ROOM_PALETTE.length]?.hex ?? '#3d7bff';
    return room(id, k + 4, { colour, accent: lightenHex(colour, 0.45), species: SPECIES_CYCLE[k % SPECIES_CYCLE.length] ?? 'bun' });
  })];
};

/** An online server for every host of these rooms. */
export const serversFor = (rooms: readonly RoomDTO[]): readonly ServerDTO[] =>
  rooms.flatMap((r) => (r.host === null ? [] : [server(r.host)]));

/** A snapshot of these rooms with `perRoom` working sessions in each. */
export const roomSnap = (rooms: readonly RoomDTO[], perRoom = 0, options: Omit<SnapOptions, 'servers'> = {}): AgencySnapshot => buildSnapshot({
  servers: serversFor(rooms), rooms,
  sessions: rooms.flatMap((r) => (r.host === null ? [] : many(r.host, perRoom))),
  questions: [],
  luady: options.luady === undefined ? { state: 'running', since: new Date(NOW).toISOString(), claudeSessionId: null, queued: 0 } : options.luady,
  now: NOW,
  previousSeats: (options.previous?.seats ?? {}) as SeatMap,
  ...(options.jiraRooms === undefined ? {} : { jiraRooms: options.jiraRooms }),
});

/** The classic rooms (with their home-project globs) of these servers, in slot order. */
export const classicRoomsFor = (servers: readonly ServerDTO[]): readonly RoomDTO[] => {
  const names = new Set(servers.map((s) => s.name));
  return classicRoomDtos().filter((r) => names.has(r.id));
};

/** A snapshot of these sessions in the classic rooms of its servers; seats carry over from `previous` like the page does. */
export const snap = (sessions: readonly SessionDTO[], options: SnapOptions = {}): AgencySnapshot =>
  buildSnapshot({
    servers: options.servers ?? ALL_SERVERS,
    rooms: classicRoomsFor(options.servers ?? ALL_SERVERS),
    sessions,
    questions: [],
    luady: options.luady === undefined ? { state: 'running', since: new Date(NOW).toISOString(), claudeSessionId: null, queued: 0 } : options.luady,
    now: NOW,
    previousSeats: (options.previous?.seats ?? {}) as SeatMap,
    ...(options.helpers === undefined ? {} : { helpers: options.helpers }),
    ...(options.contextPct === undefined ? {} : { contextPct: options.contextPct }),
    ...(options.jiraRooms === undefined ? {} : { jiraRooms: options.jiraRooms }),
  });
