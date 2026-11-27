import type { LuadyStatusDTO, QuestionDTO, RoomDTO, ServerDTO, SessionDTO } from '@luady/shared';
import { buildRoomIndex, roomOf, type RoomIndex } from '@luady/shared/pure';
import type { DeskMode, DeskSlot } from './desks.js';
import { fixturesFor, type FixtureDef } from './fixtures.js';
import { buildOffice, type OfficeMap } from './layout.js';
import { lookFor, type CharacterLook } from './looks.js';
import { desksFor, hasLounge, loungeOn, propsFor, type PropDef } from './props.js';
import { isFurnished, type RoomDef } from './rooms.js';
import { assignSeats, type SeatMap, type SeatResult } from './seats.js';
import type { PixelPoint } from './types.js';
import { visualFor, type ToolKind, type Visual } from './visuals.js';
import { orderByQuestionAge } from './needs.js';

export interface SnapshotInput {
  readonly servers: readonly ServerDTO[];
  /** The rooms (`GET /api/rooms`): they lay out the map, and sessions are placed in them. */
  readonly rooms: readonly RoomDTO[];
  readonly sessions: readonly SessionDTO[];
  readonly questions: readonly QuestionDTO[];
  readonly luady: LuadyStatusDTO | null;
  /** Epoch ms. */
  readonly now: number;
  readonly previousSeats: SeatMap;
  /** sessionId → current tool (empty until kit 2). */
  readonly tools?: Readonly<Record<string, ToolKind | null>>;
  readonly paused?: ReadonlySet<string>;
  /** sessionId → epoch ms of its last tool step. Silence ("?" bubble) is measured from here; no entry means no warning. */
  readonly stepTimes?: Readonly<Record<string, number>>;
  /** sessionId → helpers (sub-agents) running now; no entry means none. */
  readonly helpers?: Readonly<Record<string, number>>;
  /** sessionId → share of its context in use (0–100); null or no entry means no reading. */
  readonly contextPct?: Readonly<Record<string, number | null>>;
  /** Rooms that have Jira connected: each hangs a Jira board (a fixture) instead of its painted one. */
  readonly jiraRooms?: readonly string[];
}

export interface ActorView {
  readonly id: string; readonly room: string; readonly name: string; readonly project: string | null;
  readonly state: string; readonly look: CharacterLook; readonly visual: Visual;
  readonly seat: number; readonly sit: PixelPoint; readonly desk: PixelPoint;
  readonly qid: string | null; readonly origin: 'owner' | 'manager' | 'system';
  /** Helpers running now (0 when unknown); the map draws up to HELPERS_DRAWN_MAX beside the desk. */
  readonly helpers: number;
  /** Its context is at least STRAIN_PCT full (the map draws a sweat drop). */
  readonly strained: boolean;
  /** How full its context is (0–100, as the hub sends it); null when there is no reading. Its monitor shows it as a bar. */
  readonly contextPct: number | null;
}

/** Context use from which an agent shows the strain mark. */
export const STRAIN_PCT = 90;
/** The most helpers drawn beside one desk. */
export const HELPERS_DRAWN_MAX = 3;

export interface RackView { readonly status: 'online' | 'offline' | 'connecting'; readonly load: number; readonly memory: 'ok' | 'tight'; readonly disk: 'ok' | 'low' }

export interface RoomView {
  readonly id: string; readonly def: RoomDef;
  /** The host whose sessions and rack the room shows (its def's host); null for HQ, empty slots and any-host rooms. */
  readonly host: string | null;
  readonly mode: DeskMode; readonly actors: readonly string[];
  readonly overflow: readonly string[]; readonly needsOwner: number;
  /** The host's rack lights; null for HQ, empty slots, a room without a host, and a host that sent no numbers yet. */
  readonly rack: RackView | null;
  /** The host's link, even before it sends numbers; null for HQ, empty slots and rooms without a host. */
  readonly status: 'online' | 'offline' | 'connecting' | null;
  /** Lounge furniture is out: only rooms with lounge pieces that qualify (see loungeOn). slots then holds 8 desks. */
  readonly lounge: boolean;
}

/** The manager: `off` is switched off by the owner (a calm, quiet state), `down` is on but not reachable. */
export interface LuadyView { readonly state: 'running' | 'busy' | 'starting' | 'down' | 'off'; readonly queued: number }

export interface AgencySnapshot {
  readonly map: OfficeMap;
  readonly rooms: Readonly<Record<string, RoomView>>;
  readonly actors: Readonly<Record<string, ActorView>>;
  readonly luady: LuadyView;
  readonly seats: SeatMap;
  /** Ids of every live session waiting for the owner (on a desk, overflowed or unplaced), oldest question first. */
  readonly needs: readonly string[];
  /** The part of `needs` that has no actor on the map (overflowed or unplaced). */
  readonly waitingElsewhere: readonly string[];
  /** The desks that exist now, per room: draw all of them, and pass this record to walkGrid. */
  readonly slots: Readonly<Record<string, readonly DeskSlot[]>>;
  readonly props: readonly PropDef[];
  /** What can be pressed on the map besides characters and rooms; each has a prop of the same id in `props`. */
  readonly fixtures: readonly FixtureDef[];
  /** Live sessions that have no room on the map. */
  readonly unplaced: readonly string[];
}

/** load1 at which the rack lights run flat out. */
const FULL_LOAD = 4;
const TIGHT_MEMORY_RATIO = 0.15;
const LOW_DISK_KB = 10 * 1024 * 1024;
const LUADY_DOWN: LuadyView = Object.freeze({ state: 'down', queued: 0 });

/** Rack lights from the server numbers; null when the hub has no numbers yet. */
const rackFor = (server: ServerDTO | undefined): RackView | null => {
  const info = server?.sysinfo;
  if (server === undefined || info === null || info === undefined) return null;
  const load = Number.isFinite(info.load1) ? Math.max(0, Math.min(1, info.load1 / FULL_LOAD)) : 0;
  return Object.freeze({
    status: server.status,
    load,
    memory: info.mem_avail_kb / info.mem_total_kb < TIGHT_MEMORY_RATIO ? 'tight' : 'ok',
    disk: info.disk_free_kb < LOW_DISK_KB ? 'low' : 'ok',
  });
};

/** Milliseconds since an ISO time; 0 when missing, unreadable or in the future. */
const since = (now: number, at: string | null): number => {
  if (at === null) return 0;
  const t = Date.parse(at);
  return Number.isFinite(t) && Number.isFinite(now) ? Math.max(0, now - t) : 0;
};

/** A live session with its room, and whether it visits from another room's project. */
interface Placed { readonly session: SessionDTO; readonly room: string; readonly guest: boolean }

interface Sorted { readonly live: readonly SessionDTO[]; readonly placed: readonly Placed[]; readonly unplaced: readonly string[] }

/** Not a system session, not ended, and registered, or just starting (the hub publishes a start before the kit registers it). */
const isLive = (s: SessionDTO): boolean => s.origin !== 'system' && s.state !== 'ended' && (s.registered || s.state === 'starting');

/**
 * Where a live session sits, and whether it is a guest there: both as roomOf decides, if that room is on
 * the map. roomOf calls a session a guest only when one of its home room's matches could be compared and none fits.
 */
const placeOf = (s: SessionDTO, map: OfficeMap, index: RoomIndex): Placed | null => {
  const place = roomOf({ host: s.host, project: s.project, cwd: s.cwd }, index);
  const def = place === null ? undefined : map.rooms[place.room];
  if (place === null || def === undefined || !isFurnished(def)) return null;
  return { session: s, room: place.room, guest: place.guest };
};

/** Live sessions with a room go on the map; live ones without a room are unplaced; the rest are skipped. */
const sortSessions = (sessions: readonly SessionDTO[], map: OfficeMap, index: RoomIndex): Sorted => {
  const unique = [...new Map(sessions.toReversed().map((s) => [s.id, s])).values()].toReversed();
  const live = unique.filter(isLive);
  const placed: Placed[] = [];
  const unplaced: string[] = [];
  live.forEach((s) => {
    const at = placeOf(s, map, index);
    if (at === null) unplaced.push(s.id);
    else placed.push(at);
  });
  return { live, placed, unplaced: unplaced.toSorted() };
};

/**
 * Seats to remember for the next snapshot: this snapshot's seats, plus the earlier desk of every session that is still
 * here and alive but not on the map now (no server row yet, say). Only sessions that are gone or ended are forgotten.
 */
const rememberedSeats = (input: SnapshotInput, placed: readonly Placed[], seats: SeatMap): SeatMap => {
  const onMap = new Set(placed.map((p) => p.session.id));
  const kept = input.sessions.flatMap((s) => {
    if (s.state === 'ended' || onMap.has(s.id) || !Object.hasOwn(input.previousSeats, s.id)) return [];
    const seat = input.previousSeats[s.id];
    return seat === undefined ? [] : [[s.id, seat] as const];
  });
  return Object.freeze({ ...Object.fromEntries(kept), ...seats });
};

interface Context {
  readonly map: OfficeMap;
  readonly seats: SeatMap;
  readonly slots: Readonly<Record<string, readonly DeskSlot[]>>;
  readonly visuals: ReadonlyMap<string, Visual>;
  readonly input: SnapshotInput;
}

const toolOf = (tools: SnapshotInput['tools'], id: string): ToolKind | null =>
  tools !== undefined && Object.hasOwn(tools, id) ? (tools[id] ?? null) : null;

/** Milliseconds since the session's last step; 0 without a (usable) step time, so a long turn alone never warns. */
const silentFor = (input: SnapshotInput, id: string): number => {
  const steps = input.stepTimes;
  const at = steps !== undefined && Object.hasOwn(steps, id) ? steps[id] : undefined;
  return at !== undefined && Number.isFinite(at) && Number.isFinite(input.now) ? Math.max(0, input.now - at) : 0;
};

const helpersOf = (input: SnapshotInput, id: string): number => {
  const n = input.helpers !== undefined && Object.hasOwn(input.helpers, id) ? input.helpers[id] : undefined;
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : 0;
};

/** The session's context reading, kept within 0–100; null when missing or unreadable. */
const contextOf = (input: SnapshotInput, id: string): number | null => {
  const pct = input.contextPct !== undefined && Object.hasOwn(input.contextPct, id) ? input.contextPct[id] : undefined;
  return typeof pct === 'number' && Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
};

const strainedOf = (input: SnapshotInput, id: string): boolean => {
  const pct = contextOf(input, id);
  return pct !== null && pct >= STRAIN_PCT;
};

/** Pose, bubble and monitor of one live session, whether or not it has a desk. */
const visualOf = (s: SessionDTO, input: SnapshotInput): Visual =>
  visualFor({
    state: s.state, idleMs: since(input.now, s.lastEventAt), silentMs: silentFor(input, s.id),
    tool: toolOf(input.tools, s.id), paused: input.paused?.has(s.id) ?? false,
  });

/** The actor of a seated session; null for one that overflowed its room. */
const actorFor = (p: Placed, ctx: Context): ActorView | null => {
  const s = p.session;
  const room = ctx.map.rooms[p.room];
  const seat = Object.hasOwn(ctx.seats, s.id) ? ctx.seats[s.id] : undefined;
  const slot = seat === undefined ? undefined : ctx.slots[p.room]?.[seat];
  const visual = ctx.visuals.get(s.id);
  if (room === undefined || seat === undefined || slot === undefined || visual === undefined) return null;
  return Object.freeze({
    id: s.id, room: p.room, name: s.displayName, project: s.project, state: s.state,
    look: lookFor(s.id, room, p.guest), visual, seat, sit: slot.sit, desk: slot.desk, qid: s.pendingQid, origin: s.origin,
    helpers: helpersOf(ctx.input, s.id), strained: strainedOf(ctx.input, s.id), contextPct: contextOf(ctx.input, s.id),
  });
};

/** Items per key, in their given order: one pass over the items. */
const groupBy = <T>(items: readonly T[], keyOf: (item: T) => string): ReadonlyMap<string, readonly T[]> => {
  const groups = new Map<string, T[]>();
  items.forEach((item) => {
    const key = keyOf(item);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [item]);
    else list.push(item);
  });
  return groups;
};

interface Needs { readonly all: readonly string[]; readonly elsewhere: readonly string[]; readonly perRoom: ReadonlyMap<string, number> }

/** Every live session waiting for the owner (seated, overflowed or unplaced), oldest question first; rooms count seated and overflow. */
const needsOf = (sorted: Sorted, visuals: ReadonlyMap<string, Visual>, questions: readonly QuestionDTO[], actors: readonly ActorView[]): Needs => {
  const waiting = sorted.live.filter((s) => visuals.get(s.id)?.needsOwner === true);
  const all = orderByQuestionAge(waiting.map((s) => ({ id: s.id, qid: s.pendingQid })), questions);
  const seated = new Set(actors.map((a) => a.id));
  const waits = new Set(waiting.map((s) => s.id));
  const perRoom = new Map<string, number>();
  sorted.placed.forEach((p) => {
    if (waits.has(p.session.id)) perRoom.set(p.room, (perRoom.get(p.room) ?? 0) + 1);
  });
  return { all, elsewhere: Object.freeze(all.filter((id) => !seated.has(id))), perRoom };
};

interface RoomFacts {
  readonly seated: SeatResult;
  readonly actorsByRoom: ReadonlyMap<string, readonly ActorView[]>;
  readonly serverByHost: ReadonlyMap<string, ServerDTO>;
  readonly lounge: Readonly<Record<string, boolean>>;
  readonly needs: Needs;
}

const NONE: readonly string[] = Object.freeze([]);

const roomView = (key: string, def: RoomDef, facts: RoomFacts): RoomView => {
  const mine = (facts.actorsByRoom.get(key) ?? []).toSorted((a, b) => a.seat - b.seat);
  const server = isFurnished(def) && def.host !== null ? facts.serverByHost.get(def.host) : undefined;
  return Object.freeze({
    id: key, def, host: def.host, mode: facts.seated.modes[key] ?? 'normal',
    actors: Object.freeze(mine.map((a) => a.id)),
    overflow: facts.seated.overflow[key] ?? NONE,
    needsOwner: facts.needs.perRoom.get(key) ?? 0,
    rack: rackFor(server),
    status: server?.status ?? null,
    lounge: facts.lounge[key] ?? false,
  });
};

/** Per room key: is the lounge out? Decided from the final seats; only rooms with lounge pieces can have it out. */
const loungeFlags = (map: OfficeMap, seated: SeatResult, byRoom: ReadonlyMap<string, readonly Placed[]>): Readonly<Record<string, boolean>> =>
  Object.freeze(Object.fromEntries(map.order.flatMap((key) => {
    const def = map.rooms[key];
    if (def === undefined) return [];
    const seats = (byRoom.get(key) ?? []).flatMap((p) => (Object.hasOwn(seated.seats, p.session.id) ? [seated.seats[p.session.id] ?? 0] : []));
    return [[key, hasLounge(def) && loungeOn(seated.modes[key] ?? 'normal', seats)] as const];
  })));

/** Per room key, the desks that exist now: see desksFor. */
const roomSlots = (map: OfficeMap, seated: SeatResult, lounge: Readonly<Record<string, boolean>>): Readonly<Record<string, readonly DeskSlot[]>> =>
  Object.freeze(Object.fromEntries(map.order.flatMap((key) => {
    const def = map.rooms[key];
    return def === undefined ? [] : [[key, desksFor(def, seated.modes[key] ?? 'normal', lounge[key] ?? false)] as const];
  })));

const luadyView = (luady: LuadyStatusDTO | null): LuadyView =>
  (luady === null ? LUADY_DOWN : Object.freeze({ state: luady.state, queued: luady.queued }));

/** One index per rooms array: the hub sends a new array only when the rooms change. */
const INDEXES = new WeakMap<readonly RoomDTO[], RoomIndex>();

const indexOf = (rooms: readonly RoomDTO[]): RoomIndex => {
  const known = INDEXES.get(rooms);
  if (known !== undefined) return known;
  const made = buildRoomIndex(rooms);
  INDEXES.set(rooms, made);
  return made;
};

/** The first server row of each host. */
const serversByHost = (servers: readonly ServerDTO[]): ReadonlyMap<string, ServerDTO> => {
  const byHost = new Map<string, ServerDTO>();
  servers.forEach((s) => {
    if (!byHost.has(s.name)) byHost.set(s.name, s);
  });
  return byHost;
};

/** Everything the agency page needs to draw one moment of the office, from live hub data. */
export function buildSnapshot(input: SnapshotInput): AgencySnapshot {
  const map = buildOffice(input.rooms);
  const sorted = sortSessions(input.sessions, map, indexOf(input.rooms));
  const { placed, unplaced } = sorted;
  const byRoom = groupBy(placed, (p) => p.room);
  const seated = assignSeats(placed.map((p) => ({ id: p.session.id, room: p.room })), input.previousSeats);
  const lounge = loungeFlags(map, seated, byRoom);
  const slots = roomSlots(map, seated, lounge);
  const visuals = new Map(sorted.live.map((s) => [s.id, visualOf(s, input)]));
  const actors = placed.flatMap((p) => actorFor(p, { map, seats: seated.seats, slots, visuals, input }) ?? []);
  const needs = needsOf(sorted, visuals, input.questions, actors);
  const facts: RoomFacts = { seated, actorsByRoom: groupBy(actors, (a) => a.room), serverByHost: serversByHost(input.servers), lounge, needs };
  const fixtureOptions = { jiraRooms: input.jiraRooms ?? [] };
  return Object.freeze({
    map,
    rooms: Object.freeze(Object.fromEntries(map.order.flatMap((key) => {
      const def = map.rooms[key];
      return def === undefined ? [] : [[key, roomView(key, def, facts)] as const];
    }))),
    actors: Object.freeze(Object.fromEntries(actors.map((a) => [a.id, a]))),
    luady: luadyView(input.luady),
    seats: rememberedSeats(input, placed, seated.seats),
    needs: needs.all,
    waitingElsewhere: needs.elsewhere,
    slots,
    props: propsFor(map, lounge, fixtureOptions),
    fixtures: fixturesFor(map, fixtureOptions),
    unplaced: Object.freeze(unplaced),
  });
}
