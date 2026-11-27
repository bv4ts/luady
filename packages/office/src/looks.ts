import { isFurnished, type RoomDef } from './rooms.js';
import type { Palette, Species } from './types.js';

/** How one session's creature looks. Same id, same look, on every device. */
export interface CharacterLook {
  readonly species: Species;
  /** Its room's colours. */
  readonly palette: Palette;
  /** 0..5: recolours the accent (or the ghost's star); manager and mini look the same in every variant. */
  readonly variant: number;
  /** Working on a project from another office: wears a scarf. */
  readonly guest: boolean;
}

export const LOOK_VARIANTS = 6;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const REPLACEMENT = 0xfffd;

/** 32-bit FNV-1a over bytes, unsigned. */
export function hashBytes(bytes: ArrayLike<number>): number {
  let hash = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= (bytes[i] ?? 0) & 0xff;
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

const utf8Of = (cp: number): readonly number[] => {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 0x3f)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f)];
};

/** UTF-8 bytes of a string; a lone surrogate becomes U+FFFD, as TextEncoder does. */
const utf8 = (text: string): readonly number[] =>
  Array.from(text).flatMap((ch) => {
    const cp = ch.codePointAt(0) ?? REPLACEMENT;
    return utf8Of(cp >= 0xd800 && cp <= 0xdfff ? REPLACEMENT : cp);
  });

/** 32-bit FNV-1a of the id's UTF-8 bytes, unsigned. */
export function hashId(id: string): number {
  return hashBytes(utf8(id));
}

/**
 * The creature for a session: species and palette from its room, accent variant from its id. `guest` comes from the
 * placement (roomOf); only a furnished room has guests.
 */
export function lookFor(sessionId: string, room: RoomDef, guest: boolean): CharacterLook {
  return Object.freeze({
    species: room.species,
    palette: room.palette,
    variant: hashId(sessionId) % LOOK_VARIANTS,
    guest: guest && isFurnished(room),
  });
}
