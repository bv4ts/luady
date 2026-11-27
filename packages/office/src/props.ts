import { slotsFor, type DeskMode, type DeskSlot } from './desks.js';
import { ROOM_H, bandY, colX, geometryOf, type Geometry } from './grid.js';
import type { OfficeMap } from './layout.js';
import { createMemo } from './memo.js';
import { fixtureProps, type FixtureOptions } from './fixtures.js';
import { HQ_ID, isFurnished, type Orientation, type RoomDef } from './rooms.js';
import { HQ_ROOM_PIECES, HQ_WORK_PIECES, LOUNGE_ORDER, ROOM_TEMPLATES, STREET_PIECES, placePiece, type Piece } from './templates.js';
import type { TileRect } from './types.js';

export type PropKind =
  | 'rack' | 'plant' | 'luadydesk' | 'workbench' | 'versions' | 'sofa' | 'coffee' | 'table'
  | 'board' | 'library' | 'notes' | 'fuse' | 'jira' | 'clock' | 'schedule' | 'tv' | 'wins' | 'robot' | 'links'
  | 'meeting' | 'cooler' | 'readbench';

/** A piece of furniture that takes part in depth sorting. x/y is the sprite's top-left pixel; sortY is where it meets the floor. */
export interface PropDef {
  readonly id: string;
  readonly kind: PropKind;
  readonly x: number;
  readonly y: number;
  readonly sortY: number;
  /** Key of the room it stands in, or null in a street. */
  readonly room: string | null;
  readonly blocks: readonly TileRect[];
  /** Lounge furniture stands where the third row of normal desks goes; it is shown only while its room's lounge is on. */
  readonly lounge: boolean;
}

/** Normal desks from this index on (the third row) stand on the lounge furniture of the rooms that have one. */
export const LOUNGE_FIRST_BLOCKING_SEAT = 8;

/** A room's lounge is out only in normal mode while no one sits at the third desk row. Tight mode never has one. */
export function loungeOn(mode: DeskMode, seats: readonly number[]): boolean {
  return mode === 'normal' && seats.every((seat) => seat < LOUNGE_FIRST_BLOCKING_SEAT);
}

/**
 * True for a furnished room whose orientation has lounge pieces (east-north, west-south and east-south: Harbor, Meadow
 * and Private Projects in the classic four); west-north rooms, HQ and empty slots have none.
 */
export function hasLounge(room: RoomDef): boolean {
  return isFurnished(room) && room.orientation !== null && ROOM_TEMPLATES[room.orientation].lounge.length > 0;
}

/** The desks that exist: only the first LOUNGE_FIRST_BLOCKING_SEAT while the lounge is out, otherwise all of them. */
export function shownSlots(all: readonly DeskSlot[], lounge: boolean): readonly DeskSlot[] {
  return lounge && all.length > LOUNGE_FIRST_BLOCKING_SEAT ? Object.freeze(all.slice(0, LOUNGE_FIRST_BLOCKING_SEAT)) : all;
}

const LOUNGE_DESKS = new WeakMap<readonly DeskSlot[], readonly DeskSlot[]>();

/** The desks that exist in a room for its mode and lounge (shownSlots of slotsFor); the same inputs give the same list. */
export function desksFor(room: RoomDef, mode: DeskMode, lounge: boolean): readonly DeskSlot[] {
  const all = slotsFor(room, mode);
  if (!lounge) return all;
  const known = LOUNGE_DESKS.get(all);
  if (known !== undefined) return known;
  const shown = shownSlots(all, true);
  LOUNGE_DESKS.set(all, shown);
  return shown;
}

/**
 * One piece placed in the office. `ring` names it within the first ring (slots 0-3, the two streets beside HQ, HQ
 * itself), where it keeps the classic office's id; elsewhere its id names its place.
 */
interface Placing {
  readonly piece: Piece;
  readonly baseX: number;
  readonly baseY: number;
  readonly room: string | null;
  readonly ring: string | null;
  readonly place: string;
  readonly index: number;
}

const furnishedInSlotOrder = (map: OfficeMap): readonly RoomDef[] =>
  map.order.flatMap((key) => {
    const room = map.rooms[key];
    return room !== undefined && isFurnished(room) && room.slot !== null ? [room] : [];
  });

const inRing = (room: RoomDef): boolean => room.slot !== null && room.slot.index < 4;

/** A room's piece: the classic office's place key in the first ring, its slot elsewhere. */
const roomPlacing = (room: RoomDef, piece: Piece, group: 'plant' | 'lounge', index: number): Placing => ({
  piece, baseX: room.rect.x, baseY: room.rect.y, room: room.id, index,
  ring: inRing(room) ? `${group}:${room.orientation ?? ''}:${index}` : null, place: `slot${room.slot?.index ?? 0}-${group}`,
});

const centrePlacing = (g: Geometry, group: 'work' | 'room') => (piece: Piece, index: number): Placing => ({
  piece, baseX: g.hqMid, baseY: 0, room: HQ_ID, ring: `${group}:${index}`, place: group, index,
});

/** Every street segment's pieces, band by band and column by column, west before east. */
const streetPlacings = (g: Geometry): readonly Placing[] =>
  Array.from({ length: g.R }, (_, row) => row).flatMap((row) => Array.from({ length: g.K }, (_, c) => c + 1).flatMap((col) =>
    (['west', 'east'] as const).flatMap((side) => STREET_PIECES[side].map((piece, index): Placing => ({
      piece, baseX: colX(g, side, col), baseY: bandY(row) + ROOM_H, room: null, index,
      ring: col === 1 && row === 0 ? `street:${side}:${index}` : null, place: `${side}${col}-row${row}`,
    })))));

/**
 * The furniture of an office in the classic office's order: room plants (slot order), HQ's work furniture, the street segments,
 * the lounges (east-north, east-south, west-south rooms, each in slot order), then HQ's own furniture.
 */
const placings = (map: OfficeMap, rooms: readonly RoomDef[]): readonly Placing[] => {
  const g = geometryOf(map);
  return [
    ...rooms.flatMap((r) => (r.orientation === null ? [] : [roomPlacing(r, ROOM_TEMPLATES[r.orientation].plant, 'plant', 0)])),
    ...HQ_WORK_PIECES.map(centrePlacing(g, 'work')),
    ...streetPlacings(g),
    ...LOUNGE_ORDER.flatMap((o) => rooms.filter((r) => r.orientation === o).flatMap((r) => ROOM_TEMPLATES[o].lounge.map((p, i) => roomPlacing(r, p, 'lounge', i)))),
    ...HQ_ROOM_PIECES.map(centrePlacing(g, 'room')),
  ];
};

/** Slots 0-3 face these ways (nw, ne, sw, se). */
const RING_ORIENTATIONS: readonly Orientation[] = ['west-north', 'east-north', 'west-south', 'east-south'];

/** The first ring with every slot furnished: its pieces counted per kind give the classic office's ids (plant-1, plant-2, …). */
const RING_IDS: ReadonlyMap<string, string> = (() => {
  const keys = [
    ...RING_ORIENTATIONS.map((o) => [ROOM_TEMPLATES[o].plant.kind, `plant:${o}:0`] as const),
    ...HQ_WORK_PIECES.map((p, i) => [p.kind, `work:${i}`] as const),
    ...(['west', 'east'] as const).flatMap((side) => STREET_PIECES[side].map((p, i) => [p.kind, `street:${side}:${i}`] as const)),
    ...LOUNGE_ORDER.flatMap((o) => ROOM_TEMPLATES[o].lounge.map((p, i) => [p.kind, `lounge:${o}:${i}`] as const)),
    ...HQ_ROOM_PIECES.map((p, i) => [p.kind, `room:${i}`] as const),
  ];
  const seen = new Map<string, number>();
  return new Map(keys.map(([kind, key]) => {
    const n = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, n);
    return [key, `${kind}-${n}`] as const;
  }));
})();

const idOf = (p: Placing): string =>
  (p.ring === null ? undefined : RING_IDS.get(p.ring)) ?? `${p.piece.kind}-${p.place}-${p.index}`;

const isOn = (lounge: Readonly<Record<string, boolean>>, room: string | null): boolean =>
  room !== null && Object.hasOwn(lounge, room) && lounge[room] === true;

const PROPS = createMemo<readonly PropDef[]>();

/**
 * The furniture of this office. Empty slots stay empty. Lounge pieces appear only in rooms whose flag in `lounge`
 * is true (see loungeOn); a room missing from the record has its lounge off. Racks and other furniture always appear,
 * then the fixtures (HQ's board, library, notes desk and fuse box; a Jira board in each room of `options.jiraRooms`).
 * The same room layout, rooms with their lounge out and Jira rooms give back the same (frozen) list.
 */
export function propsFor(map: OfficeMap, lounge: Readonly<Record<string, boolean>>, options?: FixtureOptions): readonly PropDef[] {
  const out = Object.keys(lounge).filter((room) => isOn(lounge, room)).toSorted();
  const fixtures = fixtureProps(map, options);
  const jira = fixtures.filter((p) => p.kind === 'jira').map((p) => p.id);
  return PROPS.get(`${map.layoutKey}|${map.order.join(',')}|${out.join(',')}|${jira.join(',')}`, () => furnish(map, lounge, fixtures));
}

const furnish = (map: OfficeMap, lounge: Readonly<Record<string, boolean>>, fixtures: readonly PropDef[]): readonly PropDef[] => {
  const racks = fixtures.filter((p) => p.kind === 'rack');
  const placed = placings(map, furnishedInSlotOrder(map)).flatMap((p): PropDef[] => {
    if (p.piece.lounge && !isOn(lounge, p.room)) return [];
    const at = placePiece(p.piece, p.baseX, p.baseY);
    return [Object.freeze({
      id: idOf(p), kind: p.piece.kind, x: at.x, y: at.y, sortY: at.sortY, room: p.room, blocks: Object.freeze([at.block]), lounge: p.piece.lounge,
    })];
  });
  return Object.freeze([...racks, ...placed, ...fixtures.filter((p) => p.kind !== 'rack')]);
};
