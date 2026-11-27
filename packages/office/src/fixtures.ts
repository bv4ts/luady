import { LINKS_H, LINKS_W, WALL_BOARD_H, decorOf } from './decor.js';
import { geometryOf, type Geometry } from './grid.js';
import type { OfficeMap } from './layout.js';
import { createMemo } from './memo.js';
import type { PropDef, PropKind } from './props.js';
import { HQ_ID, isFurnished, type RoomDef } from './rooms.js';
import { TILE as T, type PixelPoint, type PixelRect, type TileRect } from './types.js';

/** Things on the map that open something when pressed. */
export type FixtureKind =
  | 'rack' | 'board' | 'library' | 'notes' | 'fuse' | 'jira'
  | 'tv' | 'clock' | 'schedule' | 'wins' | 'robot' | 'links';

export const FIXTURE_KINDS: readonly FixtureKind[] = Object.freeze([
  'rack', 'board', 'library', 'notes', 'fuse', 'jira',
  'tv', 'clock', 'schedule', 'wins', 'robot', 'links',
] as const);

export interface FixtureDef {
  /** `${kind}-${room}`. */
  readonly id: string;
  readonly kind: FixtureKind;
  /** Room key, or 'corridor'. */
  readonly room: string;
  /** What a tap hits, in map pixels: the fixture's picture. */
  readonly box: PixelRect;
  /** Top-centre of the art: badges and labels hang here. */
  readonly anchor: PixelPoint;
  readonly label: string;
}

export interface FixtureOptions {
  /** Rooms that hang a Jira board instead of their painted wall board. */
  readonly jiraRooms?: readonly string[];
}

/** Every fixture is a piece of furniture of its own kind (the rack too: see rackProp). */
type FixtureProp = Extract<PropKind, FixtureKind>;

/** Picture sizes of the fixture furniture, in pixels; furnitureRaster draws exactly these. */
export const FIXTURE_SIZE: Readonly<Record<FixtureProp, { readonly w: number; readonly h: number }>> = Object.freeze({
  rack: Object.freeze({ w: 30, h: 46 }),
  board: Object.freeze({ w: 144, h: 30 }),
  library: Object.freeze({ w: 132, h: 32 }),
  notes: Object.freeze({ w: 60, h: 34 }),
  fuse: Object.freeze({ w: 20, h: 26 }),
  jira: Object.freeze({ w: 62, h: WALL_BOARD_H }),
  clock: Object.freeze({ w: 12, h: 12 }),
  schedule: Object.freeze({ w: 26, h: 24 }),
  tv: Object.freeze({ w: 56, h: 28 }),
  wins: Object.freeze({ w: 80, h: 26 }),
  robot: Object.freeze({ w: 22, h: 28 }),
  links: Object.freeze({ w: LINKS_W, h: LINKS_H }),
});

const LABELS: Readonly<Record<FixtureProp, string>> = Object.freeze({
  rack: 'Server', board: 'Board', library: 'Library', notes: 'Notes', fuse: 'Accounts', jira: 'Jira',
  clock: 'Today', schedule: 'Schedule', tv: 'Fleet', wins: 'Wins', robot: 'Help', links: 'Links',
});

const tiles = (x: number, y: number, w: number, h: number): TileRect => Object.freeze({ x, y, w, h });

interface Placed { readonly kind: FixtureProp; readonly x: number; readonly y: number; readonly sortY: number; readonly blocks: readonly TileRect[] }

/**
 * HQ's fixtures in a grid, as offsets from its first column (hqX), its centre column (hqMid) and the first column east
 * of it (eastX). The wall face is y 16–47: the board, the clock, the schedule, the TV (hqX·16 + 182, + 348 and + 380:
 * 614, 780 and 812 in the first ring) and the fuse box hang on it; the library stands on row 3 against it; the notes
 * desk stands at tiles hqX + 2 … + 5 × 8–9; the wins board stands at tiles hqX + 2 … + 6 × 30; the
 * robot stands by the workbench.
 */
const hqFixtures = (g: Geometry): readonly Placed[] => {
  const notes = { x: g.hqX + 2, y: 8 };
  const wins = { x: g.hqX + 2, y: 30 };
  return [
    { kind: 'board', x: (g.hqX + 2) * T, y: 17, sortY: 17 + FIXTURE_SIZE.board.h, blocks: [] },
    { kind: 'library', x: (g.hqMid - 2) * T, y: 2 * T, sortY: 4 * T, blocks: [tiles(g.hqMid - 2, 3, 9, 1)] },
    { kind: 'notes', x: notes.x * T + 2, y: (notes.y + 2) * T - FIXTURE_SIZE.notes.h, sortY: (notes.y + 2) * T, blocks: [tiles(notes.x, notes.y, 4, 2)] },
    { kind: 'fuse', x: (g.eastX - 2) * T - 8, y: 20, sortY: 20 + FIXTURE_SIZE.fuse.h, blocks: [] },
    { kind: 'clock', x: g.hqX * T + 182, y: 22, sortY: 22 + FIXTURE_SIZE.clock.h, blocks: [] },
    { kind: 'schedule', x: g.hqX * T + 348, y: 19, sortY: 19 + FIXTURE_SIZE.schedule.h, blocks: [] },
    { kind: 'tv', x: g.hqX * T + 380, y: 18, sortY: 18 + FIXTURE_SIZE.tv.h, blocks: [] },
    { kind: 'wins', x: wins.x * T, y: (wins.y + 1) * T - FIXTURE_SIZE.wins.h, sortY: (wins.y + 1) * T, blocks: [tiles(wins.x, wins.y, 5, 1)] },
    { kind: 'robot', x: (g.hqMid + 3) * T + 5, y: 37 * T - FIXTURE_SIZE.robot.h, sortY: 37 * T, blocks: [tiles(g.hqMid + 3, 35, 2, 2)] },
  ];
};

const prop = (id: string, room: string, p: Placed): PropDef =>
  Object.freeze({ id, kind: p.kind, x: p.x, y: p.y, sortY: p.sortY, room, blocks: Object.freeze([...p.blocks]), lounge: false });

/** A room's rack: two tiles tall on its rack tile, standing against the back wall. */
export function rackProp(room: RoomDef): PropDef {
  const t = room.rackTile;
  const floor = (t.ty + 2) * T;
  const size = FIXTURE_SIZE.rack;
  return prop(`rack-${room.id}`, room.id, { kind: 'rack', x: t.tx * T + 1, y: floor - size.h, sortY: floor, blocks: [tiles(t.tx, t.ty, Math.ceil(size.w / T), 2)] });
}

/** The rooms that hold desks and a rack (server, project and local rooms), in reading order. */
const furnishedRooms = (map: OfficeMap): readonly RoomDef[] =>
  map.order.flatMap((key) => {
    const room = map.rooms[key];
    return room !== undefined && isFurnished(room) ? [room] : [];
  });

const NONE: readonly string[] = Object.freeze([]);

/** The placed rooms named in `jiraRooms`, in reading order; anything else (HQ, empty slots, unknown keys) is ignored. */
export function jiraRoomsOf(map: OfficeMap, options: FixtureOptions | undefined): readonly string[] {
  const named = options?.jiraRooms ?? [];
  if (named.length === 0) return NONE;
  const wanted = new Set(named);
  return Object.freeze(furnishedRooms(map).filter((r) => wanted.has(r.id)).map((r) => r.id));
}

const jiraProp = (room: RoomDef): PropDef | null => {
  const decor = decorOf(room);
  if (decor === null) return null;
  const b = decor.board;
  return prop(`jira-${room.id}`, room.id, { kind: 'jira', x: b.x, y: b.y, sortY: b.y + WALL_BOARD_H, blocks: [] });
};

/** A room's links pin board, on its back wall beside the wall board (see decorOf). */
const linksProp = (room: RoomDef): PropDef | null => {
  const decor = decorOf(room);
  if (decor === null) return null;
  const at = decor.links;
  return prop(`links-${room.id}`, room.id, { kind: 'links', x: at.x, y: at.y, sortY: at.y + LINKS_H, blocks: [] });
};

const FIXTURE_PROPS = createMemo<readonly PropDef[]>();

/** The furniture of every fixture: racks and links boards of the furnished rooms, HQ's fixtures, Jira boards. */
export function fixtureProps(map: OfficeMap, options?: FixtureOptions): readonly PropDef[] {
  const jira = jiraRoomsOf(map, options);
  return FIXTURE_PROPS.get(`${map.layoutKey}|${map.order.join(',')}|${jira.join(',')}`, () => {
    const rooms = furnishedRooms(map);
    const hq = hqFixtures(geometryOf(map)).map((p) => prop(`${p.kind}-${HQ_ID}`, HQ_ID, p));
    const hung = new Set(jira);
    const boards = rooms.filter((r) => hung.has(r.id)).flatMap((r) => jiraProp(r) ?? []);
    const links = rooms.flatMap((r) => linksProp(r) ?? []);
    return Object.freeze([...rooms.map(rackProp), ...hq, ...links, ...boards]);
  });
}

const isFixtureProp = (kind: PropKind): kind is FixtureProp => Object.hasOwn(FIXTURE_SIZE, kind);

const toFixture = (p: PropDef): FixtureDef | null => {
  if (!isFixtureProp(p.kind) || p.room === null) return null;
  const size = FIXTURE_SIZE[p.kind];
  return Object.freeze({
    id: p.id, kind: p.kind, room: p.room,
    box: Object.freeze({ x: p.x, y: p.y, w: size.w, h: size.h }),
    anchor: Object.freeze({ x: p.x + size.w / 2, y: p.y }),
    label: LABELS[p.kind],
  });
};

const FIXTURES = createMemo<readonly FixtureDef[]>();

/**
 * The fixtures of this office: `rack-<room>` for each furnished room, `board-hq`, `library-hq`, `notes-hq`, `fuse-hq`,
 * HQ's clock, schedule, TV, wins board and robot, `links-<room>`, and `jira-<room>` for the rooms in `jiraRooms`. Same
 * inputs, same (frozen) list.
 */
export function fixturesFor(map: OfficeMap, options?: FixtureOptions): readonly FixtureDef[] {
  const jira = jiraRoomsOf(map, options);
  return FIXTURES.get(`${map.layoutKey}|${map.order.join(',')}|${jira.join(',')}`, () =>
    Object.freeze(fixtureProps(map, { jiraRooms: jira }).flatMap((p) => toFixture(p) ?? [])));
}
