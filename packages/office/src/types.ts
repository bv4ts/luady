/** Edge of one map tile in pixels. */
export const TILE = 16;

/** A room's colours, as '#rrggbb': the body and the accent. */
export interface Palette { readonly base: string; readonly accent: string }

/** Creature shapes: the room creatures (bun, bot, shield, ghost, cat), the manager himself, and the small sub-agent helper. */
export type Species = 'bun' | 'bot' | 'shield' | 'ghost' | 'cat' | 'manager' | 'mini';

/** A room key: a room id, the HQ key, or the key of an empty slot. */
export type RoomId = string;

export interface TilePoint { readonly tx: number; readonly ty: number }
export interface PixelPoint { readonly x: number; readonly y: number }
export interface TileRect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface PixelRect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
/** The walk grid as a mask, cached per layout key; 1 = walkable, row by row. */
export interface WalkMask { readonly width: number; readonly height: number; readonly open: Uint8Array }
