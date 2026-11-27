/**
 * The office the toy shows: the product's five-room demo office (Cedar, Oak, Ash and Birch around Luady HQ) with four
 * empty lots, from public/pixel/manifest.json. Positions are map pixels, as in the product.
 */
import { MANIFEST, type Box, type BuildInfo, type Point, type RoomInfo } from '../pixel/kit';

export const OFFICE = MANIFEST.office;
export const WORLD: Box = { x: MANIFEST.world.x, y: MANIFEST.world.y, w: MANIFEST.world.w, h: MANIFEST.world.h };
/** The part of the office the toy opens on, the same as office-still.png. */
export const STILL: Box = { x: MANIFEST.still.x, y: MANIFEST.still.y, w: MANIFEST.still.w, h: MANIFEST.still.h };
/** Where the first view sits across the still when the stage is narrower: Cedar's desks stay in the middle. */
export const HOME_ALIGN = 0.38;

/** The order the office draws its rooms' frames in; where two frames touch, the later one wins. */
export const FRAME_ORDER = ['cedar', 'oak', 'hq', 'ash', 'birch', 'elm', 'lot-5', 'lot-6', 'lot-7'];
/** The lots the toy can build on, nearest first, and the rooms they become. */
export const BUILDS: BuildInfo[] = ['elm', 'lot-6', 'lot-5', 'lot-7']
  .map((lot) => OFFICE.builds.find((b) => b.lot === lot))
  .filter((b): b is BuildInfo => b !== undefined);
export const LOT_COLOUR = OFFICE.rooms['lot-5']?.palette.base ?? '#6c7689';
export const HQ_COLOUR = OFFICE.rooms.hq?.palette.base ?? '#3cc3b0';

export const CORRIDOR_Y = 336;
const HQ = OFFICE.hq;
/** HQ's two doors open on the west and east corridors at the middle of its side walls. */
const HQ_DOOR = {
  west: { inner: { x: HQ.x + 22, y: 360 }, outer: { x: HQ.x - 14, y: CORRIDOR_Y } },
  east: { inner: { x: HQ.x + HQ.w - 22, y: 360 }, outer: { x: HQ.x + HQ.w + 14, y: CORRIDOR_Y } },
};
/** The open floor below Luady's desk, where his walks in HQ start and end. */
const HQ_HUB: Point = { x: OFFICE.luadySit.x - 48, y: 360 };
const CORRIDORS: { side: 'west' | 'east'; box: Box }[] = [
  { side: 'west', box: { x: 16, y: 288, w: HQ.x - 16, h: 96 } },
  { side: 'east', box: { x: HQ.x + HQ.w, y: 288, w: OFFICE.width - 16 - (HQ.x + HQ.w), h: 96 } },
];

export interface Place { kind: 'room'; room: RoomInfo }
export type Region = Place | { kind: 'hq' } | { kind: 'corridor'; side: 'west' | 'east' };

const inside = (p: Point, b: Box, pad = 0) => p.x >= b.x + pad && p.x < b.x + b.w - pad && p.y >= b.y + pad && p.y < b.y + b.h - pad;

/** The room, HQ or corridor a point is in; `rooms` are the rooms that exist now (a lot only once it is built). */
export function regionOf(p: Point, rooms: RoomInfo[]): Region | null {
  if (inside(p, HQ)) return { kind: 'hq' };
  const room = rooms.find((r) => inside(p, r.rect));
  if (room !== undefined) return { kind: 'room', room };
  const corridor = CORRIDORS.find((c) => inside(p, c.box));
  return corridor === undefined ? null : { kind: 'corridor', side: corridor.side };
}

/** A point is somewhere Luady can stand: on a room's or HQ's floor (below the wall), or in a corridor. */
export function walkable(p: Point, rooms: RoomInfo[]): Point | null {
  const region = regionOf(p, rooms);
  if (region === null) return null;
  if (region.kind === 'corridor') return { x: p.x, y: Math.min(Math.max(p.y, 300), 372) };
  const box = region.kind === 'hq' ? HQ : region.room.rect;
  return { x: Math.min(Math.max(p.x, box.x + 20), box.x + box.w - 20), y: Math.min(Math.max(p.y, box.y + 44), box.y + box.h - 12) };
}

function door(room: RoomInfo): { x: number; inner: Point; outer: Point } {
  const x = room.doorway.x + room.doorway.w / 2;
  const north = room.doorway.y + room.doorway.h <= room.rect.y + room.rect.h && room.doorway.y > room.rect.y + room.rect.h / 2;
  const inner = north ? { x, y: room.rect.y + room.rect.h - 20 } : { x, y: room.rect.y + 44 };
  return { x, inner, outer: { x, y: CORRIDOR_Y } };
}

const sideOf = (region: Region | null, fallback: 'west' | 'east'): 'west' | 'east' => {
  if (region === null || region.kind === 'hq') return fallback;
  if (region.kind === 'corridor') return region.side;
  return region.room.side === 'east' ? 'east' : 'west';
};

/**
 * The way Luady walks from `from` to `to`: out through the door of the room he is in, along the corridor, through HQ
 * when he has to cross to the other side, and in through the door of the room he is going to. Inside a room he keeps
 * to the aisles and the clear column by the door, so he never walks through a desk.
 */
export function route(from: Point, to: Point, rooms: RoomInfo[]): Point[] {
  const a = regionOf(from, rooms);
  const b = regionOf(to, rooms);
  if (a !== null && b !== null && a.kind === 'room' && b.kind === 'room' && a.room.id === b.room.id) {
    const d = door(a.room);
    return [{ x: d.x, y: from.y }, { x: d.x, y: to.y }, to];
  }
  if (a?.kind === 'hq' && b?.kind === 'hq') return [HQ_HUB, { x: HQ_HUB.x, y: to.y }, to];
  if (a?.kind === 'corridor' && b?.kind === 'corridor' && a.side === b.side) return [to];

  const target = sideOf(b, from.x < HQ.x + HQ.w / 2 ? 'west' : 'east');
  const start = a?.kind === 'hq' ? target : sideOf(a, target);
  const path: Point[] = [];
  if (a?.kind === 'room') {
    const d = door(a.room);
    path.push({ x: d.x, y: from.y }, d.inner, d.outer);
  } else if (a?.kind === 'hq') {
    path.push({ x: HQ_HUB.x, y: from.y }, HQ_HUB, HQ_DOOR[start].inner, HQ_DOOR[start].outer);
  }
  if (start !== target && b?.kind !== 'hq') {
    path.push(HQ_DOOR[start].outer, HQ_DOOR[start].inner, HQ_HUB, HQ_DOOR[target].inner, HQ_DOOR[target].outer);
  }
  if (b?.kind === 'room') {
    const d = door(b.room);
    path.push(d.outer, d.inner, { x: d.x, y: to.y });
  } else if (b?.kind === 'hq') {
    const side = a?.kind === 'hq' ? target : start;
    path.push(HQ_DOOR[side].outer, HQ_DOOR[side].inner, HQ_HUB, { x: HQ_HUB.x, y: to.y });
  }
  path.push(to);
  return path;
}
