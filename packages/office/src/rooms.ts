import type { RoomDTO, Slot } from '@luady/shared';
import { gridFor } from '@luady/shared/pure';
import { FIRST_RING, geometryFor, roomRectOf, type Geometry } from './grid.js';
import { HQ_PALETTE, MUTE_PALETTE } from './teams.js';
import { HQ_SPOT_OFFSETS, ROOM_TEMPLATES, offsetRect, offsetTile } from './templates.js';
import type { Palette, RoomId, Species, TilePoint, TileRect } from './types.js';

export { HQ_W, ROOM_H, ROOM_W } from './grid.js';

/**
 * The HQ room: its key in `map.rooms`, its kind and its slot in `map.order`. It is the self-host id, which the literal
 * gate allows only in a few files (scripts/check-literals.allow.json): import this constant everywhere else.
 */
export const HQ_ID = 'hq';
/** Key prefix of an empty slot: `lot-<position>`. */
export const LOT_PREFIX = 'lot-';

/** Which way a room faces: its side of HQ, then its half of the band. */
export type Orientation = 'west-north' | 'east-north' | 'west-south' | 'east-south';
/**
 * server, project and local rooms come from `RoomDTO`s and are furnished; 'hq' is the manager's room; 'lot' is an empty
 * slot.
 */
export type RoomKind = 'server' | 'project' | 'local' | 'hq' | 'lot';
export type RoomSide = 'west' | 'east' | 'centre';

/** One room of the map. */
export interface RoomDef {
  readonly id: RoomId;
  readonly kind: RoomKind;
  /** The host whose sessions and rack the room shows; null for HQ, empty slots and project rooms of any host. */
  readonly host: string | null;
  readonly name: string;
  readonly short: string;
  readonly palette: Palette;
  readonly species: Species;
  /** Its slot; null for HQ. */
  readonly slot: Slot | null;
  /** Null for HQ. */
  readonly orientation: Orientation | null;
  readonly rect: TileRect;
  readonly inside: TilePoint;
  readonly doorway: TileRect;
  readonly rackTile: TilePoint;
  readonly side: RoomSide;
}

/** What a room looks like apart from its geometry (palette, species, name): it changes when a room is recoloured or renamed. */
export function visualKeyOf(room: RoomDef): string {
  return `${room.palette.base}${room.palette.accent}:${room.species}:${room.name}`;
}

/** A room that holds desks, a rack and sessions: the rooms made from `RoomDTO`s. */
export function isFurnished(room: RoomDef): boolean {
  return room.kind === 'server' || room.kind === 'project' || room.kind === 'local';
}

/** An empty slot (a lot). */
export function isEmptySlot(room: RoomDef): boolean {
  return room.kind === 'lot';
}

/*
 * The first ring's geometry (K = R = 1) under its classic names. A map's own geometry depends on its grid: read the
 * map's rooms, spots and zones, or geometryOf(map) in grid.ts.
 */

/** HQ's first column in the first ring, in tiles. */
export const HQ_X = FIRST_RING.hqX;
/** The first column east of HQ in the first ring. */
export const EAST_X = FIRST_RING.eastX;
/** HQ's centre column in the first ring: its own furniture is placed from it. */
export const HQ_MID = FIRST_RING.hqMid;

export const HQ_RECT: TileRect = FIRST_RING.hqRect;
/** HQ's doors in the first ring: west, then east (a larger office adds a south door, see Geometry.hqDoors). */
export const HQ_DOORS: readonly TileRect[] = FIRST_RING.hqDoors;
/** The first ring's corridors west and east of HQ; their outer column is wall but for the entry. */
export const CORRIDORS: readonly TileRect[] = Object.freeze(FIRST_RING.streets.map((s) => s.rect));
/** The first ring's two street doors, through the outer walls of the corridors (west first). */
export const ENTRIES: readonly TileRect[] = FIRST_RING.entries;

/** A slot's orientation: its side, then its half. */
export function orientationOf(slot: Slot): Orientation {
  return `${slot.side}-${slot.half}`;
}

/** The smallest grid that holds a slot: what a room built on its own (without a map) is placed in. */
const geometryOfSlot = (slot: Slot): Geometry => {
  const grid = gridFor(slot.index + 1);
  return geometryFor(grid.K, grid.R);
};

interface Place {
  readonly orientation: Orientation;
  readonly rect: TileRect;
  readonly inside: TilePoint;
  readonly doorway: TileRect;
  readonly rackTile: TilePoint;
  readonly side: RoomSide;
}

/** Where a slot's room sits in a grid: its rectangle, and its template's spots moved onto it. */
const placeOf = (slot: Slot, g: Geometry): Place => {
  const orientation = orientationOf(slot);
  const template = ROOM_TEMPLATES[orientation];
  const rect = roomRectOf(g, slot);
  return {
    orientation, rect, side: slot.side,
    inside: offsetTile(template.inside, rect.x, rect.y),
    doorway: offsetRect(template.door, rect.x, rect.y),
    rackTile: offsetTile(template.rack, rect.x, rect.y),
  };
};

const HQ_ROOMS = new WeakMap<Geometry, RoomDef>();

/** HQ in a grid (the first ring by default). It has no rack: its rackTile is its inside tile; its doorway is the west door. */
export function hqRoom(g: Geometry = FIRST_RING): RoomDef {
  const known = HQ_ROOMS.get(g);
  if (known !== undefined) return known;
  const inside = offsetTile(HQ_SPOT_OFFSETS.inside, g.hqMid, 0);
  const made: RoomDef = Object.freeze({
    id: HQ_ID, kind: HQ_ID, host: null, name: 'Luady HQ', short: 'Luady HQ', palette: HQ_PALETTE, species: 'manager',
    slot: null, orientation: null, rect: g.hqRect, inside, doorway: g.hqDoors[0] ?? g.hqRect, rackTile: inside,
    side: 'centre',
  });
  HQ_ROOMS.set(g, made);
  return made;
}

/**
 * Room species the office draws: every species a room may ask for. A species from outside that list
 * (input that skipped the schema) is drawn as a bun (see roomFromDto).
 */
const DRAWN_SPECIES: ReadonlySet<string> = new Set<Species>(['bun', 'bot', 'shield', 'ghost', 'cat']);

/** The species a room's creatures are drawn as, and whether that is the one the room asked for. */
export function roomSpecies(asked: RoomDTO['species']): { readonly species: Species; readonly exact: boolean } {
  return DRAWN_SPECIES.has(asked) ? { species: asked as Species, exact: true } : { species: 'bun', exact: false };
}

/** The room of a `RoomDTO` in its slot of a grid (by default the smallest grid that holds the slot). */
export function roomFromDto(dto: RoomDTO, slot: Slot, g: Geometry = geometryOfSlot(slot)): RoomDef {
  const palette: Palette = Object.freeze({ base: dto.colour, accent: dto.accent });
  return Object.freeze({
    id: dto.id, kind: dto.kind, host: dto.host, name: dto.name, short: dto.short, palette,
    species: roomSpecies(dto.species).species, slot, ...placeOf(slot, g),
  });
}

/** An empty slot of a grid (by default the smallest that holds it): drawn as a dark shell, no desks, no door. */
export function lotRoom(slot: Slot, g: Geometry = geometryOfSlot(slot)): RoomDef {
  return Object.freeze({
    id: `${LOT_PREFIX}${slot.index}`, kind: 'lot', host: null, name: 'Vacant', short: 'Vacant', palette: MUTE_PALETTE,
    species: 'mini', slot, ...placeOf(slot, g),
  });
}
