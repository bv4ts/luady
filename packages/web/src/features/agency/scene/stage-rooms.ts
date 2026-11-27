import { buildOffice, buildSnapshot, visualKeyOf, type AgencySnapshot, type OfficeMap } from '@luady/office';
import type { HostId, RoomDTO, ServerDTO, SessionDTO } from '@luady/shared';
import { DEFAULT_ROOM_PALETTE, lightenHex } from '@luady/shared/pure';
import { statsEnabled } from './stage-stats.js';

/**
 * Rooms for the stage. `roomsSnapshot`
 * gives the snapshot to draw for the stage's optional `rooms`; `harnessSnapshot` is a dev and demo office of any size,
 * for measuring the scene in a browser (`?stage-rooms=300&stage-sessions=3` on a page with the stage).
 */

/** True when two maps draw the same rooms in the same places and looks. */
export function sameOffice(a: OfficeMap, b: OfficeMap): boolean {
  if (a === b) return true;
  if (a.layoutKey !== b.layoutKey || a.order.length !== b.order.length) return false;
  return a.order.every((key, i) => {
    const ra = a.rooms[key];
    const rb = b.rooms[b.order[i] ?? ''];
    return ra !== undefined && rb !== undefined && ra.id === rb.id && visualKeyOf(ra) === visualKeyOf(rb);
  });
}

const EMPTY = new WeakMap<readonly RoomDTO[], { readonly state: string; readonly queued: number; readonly snapshot: AgencySnapshot }>();

/**
 * The snapshot the stage draws: the page's own when `rooms` is absent or the snapshot was built from these rooms;
 * else an empty office of `rooms` (no sessions, racks dark, Luady as the page's snapshot has him), made once per list.
 */
export function roomsSnapshot(snapshot: AgencySnapshot, rooms: readonly RoomDTO[] | undefined): AgencySnapshot {
  if (rooms === undefined || sameOffice(buildOffice(rooms), snapshot.map)) return snapshot;
  const known = EMPTY.get(rooms);
  if (known !== undefined && known.state === snapshot.luady.state && known.queued === snapshot.luady.queued) return known.snapshot;
  const made = buildSnapshot({
    servers: [], rooms, sessions: [], questions: [], now: Date.now(), previousSeats: {},
    luady: { state: snapshot.luady.state, since: new Date(0).toISOString(), claudeSessionId: null, queued: snapshot.luady.queued },
  });
  EMPTY.set(rooms, { state: snapshot.luady.state, queued: snapshot.luady.queued, snapshot: made });
  return made;
}

const EPOCH = '1970-01-01T00:00:00.000Z';
const SPECIES: readonly RoomDTO['species'][] = ['bun', 'bot', 'shield', 'ghost', 'cat'];

/** The classic four in their own colours, then site-05 … site-n in the default colours. */
export function harnessRooms(n: number): readonly RoomDTO[] {
  const row = (id: string, position: number, name: string, colour: string, accent: string, species: RoomDTO['species']): RoomDTO => ({
    id, name, short: name.split(' ')[0] ?? name, kind: 'server', host: id, match: [], colour, accent, species, position, size: 'm',
    hostState: 'ok', createdAt: EPOCH, updatedAt: EPOCH,
  });
  const classic = [
    row('birch', 0, 'Orchard', '#d6336c', '#74b816', 'bun'), row('ash', 1, 'Harbor', '#f76707', '#37b24d', 'bot'),
    row('cedar', 2, 'Meadow', '#12b886', '#c3fae8', 'shield'), row('local', 3, 'Private Projects', '#7c5cff', '#ffd84d', 'ghost'),
  ];
  const count = Math.max(0, Math.floor(n));
  if (count <= 4) return classic.slice(0, count);
  return [...classic, ...Array.from({ length: count - 4 }, (_, k) => {
    const colour = DEFAULT_ROOM_PALETTE[k % DEFAULT_ROOM_PALETTE.length]?.hex ?? '#3d7bff';
    const id = `site-${String(k + 5).padStart(2, '0')}`;
    return row(id, k + 4, `Site ${k + 5}`, colour, lightenHex(colour, 0.45), SPECIES[k % SPECIES.length] ?? 'bun');
  })];
}

const server = (name: string, at: string): ServerDTO => ({
  name, host: `${name}.invalid`, status: 'online', lastSeenAt: at, claudeVersion: '2.1.0', kitVersion: '1.0.0',
  sysinfo: { load1: 1, load5: 1, mem_total_kb: 8_000_000, mem_avail_kb: 4_000_000, disk_free_kb: 50 * 1024 * 1024, uptime_s: 3600 },
  kind: 'ssh', projectsRoot: null, homeDir: null, terminal: true,
});

const session = (host: string, i: number, at: string): SessionDTO => ({
  id: `${host}:h${String(i).padStart(2, '0')}`, host: host as HostId, target: `h${i}:0.0`, claudeSessionId: null, cwd: null, project: null,
  displayName: `${host} ${i + 1}`, state: i % 3 === 1 ? 'idle' : 'working', origin: 'owner', registered: true, lastEventAt: at,
  turnStartedAt: null, pendingQid: null, unexpectedEnd: false,
});

/** An office of `rooms` rooms with `perRoom` sessions in each, every server online: the harness's still picture. */
export function harnessOffice(rooms: number, perRoom: number, now: number = Date.now()): AgencySnapshot {
  const list = harnessRooms(rooms);
  const at = new Date(now).toISOString();
  const hosts = list.flatMap((r) => (r.host === null ? [] : [r.host]));
  return buildSnapshot({
    servers: hosts.map((h) => server(h, at)), rooms: list,
    sessions: hosts.flatMap((h) => Array.from({ length: Math.max(0, Math.floor(perRoom)) }, (_, i) => session(h, i, at))),
    questions: [], luady: { state: 'running', since: at, claudeSessionId: null, queued: 0 }, now, previousSeats: {},
  });
}

const PARAM_ROOMS = 'stage-rooms';
const PARAM_SESSIONS = 'stage-sessions';

/**
 * The harness office a dev or demo page asked for in its address (`?stage-rooms=<n>&stage-sessions=<k>`), or null:
 * always null in a production build without the demo flag (stage-stats.ts statsEnabled).
 */
export function harnessFromLocation(search: string = typeof location === 'undefined' ? '' : location.search): AgencySnapshot | null {
  if (!statsEnabled()) return null;
  const params = new URLSearchParams(search);
  const rooms = params.get(PARAM_ROOMS);
  if (rooms === null) return null;
  const n = rooms === 'classic' ? 4 : Number(rooms);
  const k = Number(params.get(PARAM_SESSIONS) ?? '0');
  if (!Number.isFinite(n) || n < 0 || !Number.isFinite(k) || k < 0) return null;
  return harnessOffice(n, k);
}
