import type { Geometry } from './grid.js';
import { isFurnished, type RoomDef } from './rooms.js';
import { HQ_CORNER_RUGS, HQ_DESK_RUG, ROOM_TEMPLATES, offsetRect } from './templates.js';
import { TILE as T, type TileRect } from './types.js';

export type BoardKind = 'kanban' | 'team';
/** A board on a room's back wall, in pixels: 18 px tall, `w` wide. */
export interface WallBoard { readonly x: number; readonly y: number; readonly w: number; readonly kind: BoardKind }
export interface Decor {
  readonly rug: TileRect | null;
  readonly board: WallBoard;
  /** Top-left pixel of the links pin board: west rooms hang it left of the wall board, east rooms right of it. */
  readonly links: { readonly x: number; readonly y: number };
}

/** Height of every wall board, painted or a Jira board. */
export const WALL_BOARD_H = 18;
/** The links pin board's size. */
export const LINKS_W = 24;
export const LINKS_H = 18;
/** Room kept between a wall board (at its widest, a Jira board of 62) and the links board. */
const LINKS_GAP = 12;
const JIRA_W = 62;
/** A wall board hangs this far below the top edge of its room. */
const BOARD_DY = 9;

const DECOR = new WeakMap<RoomDef, Decor>();

/**
 * What a furnished room hangs and lays down, from its orientation's template moved onto its rectangle; null for HQ
 * and empty slots. The south rooms' boards hang west and east of their door, which opens in the same wall.
 */
export function decorOf(room: RoomDef): Decor | null {
  if (!isFurnished(room) || room.orientation === null) return null;
  const known = DECOR.get(room);
  if (known !== undefined) return known;
  const t = ROOM_TEMPLATES[room.orientation];
  const board: WallBoard = Object.freeze({ x: (room.rect.x + t.board.dx) * T, y: room.rect.y * T + BOARD_DY, w: t.board.w, kind: t.board.kind });
  const links = Object.freeze(t.links === 'west' ? { x: board.x - LINKS_GAP - LINKS_W, y: board.y } : { x: board.x + JIRA_W + LINKS_GAP, y: board.y });
  const made: Decor = Object.freeze({ rug: t.rug === null ? null : offsetRect(t.rug, room.rect.x, room.rect.y), board, links });
  DECOR.set(room, made);
  return made;
}

/** HQ's rugs in a grid: round the manager's desk, then the reading corner and the sofa corner with their colours. */
export function hqRugs(g: Geometry): { readonly desk: TileRect; readonly corners: readonly (readonly [TileRect, string])[] } {
  return {
    desk: offsetRect(HQ_DESK_RUG, g.hqMid, 0),
    corners: HQ_CORNER_RUGS.map(([r, colour]) => [offsetRect(r, g.hqMid, 0), colour] as const),
  };
}
