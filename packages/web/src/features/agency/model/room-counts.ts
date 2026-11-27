import { HQ_ID, isEmptySlot, type AgencySnapshot, type RoomDef } from '@luady/office';
import { linkDown } from './words.js';

/** What a room's chip, menu row and badge say about it. */
export interface RoomCount {
  readonly key: string;
  readonly def: RoomDef;
  /** Live sessions in the room, overflow included; null for HQ, which holds no sessions. */
  readonly count: number | null;
  readonly waiting: number;
  /** The server link in words while it is not online. */
  readonly down: 'offline' | 'connecting' | null;
}

/**
 * Every room of the map with its counts, in map order (slot order, HQ in its place), from one pass over the snapshot's
 * rooms: no per-room filter over sessions. Empty slots are left out.
 */
export function roomCounts(snapshot: AgencySnapshot): readonly RoomCount[] {
  const out: RoomCount[] = [];
  for (const key of snapshot.map.order) {
    const def = snapshot.map.rooms[key];
    if (def === undefined || isEmptySlot(def)) continue;
    const room = snapshot.rooms[key];
    out.push({
      key, def, waiting: room?.needsOwner ?? 0, down: linkDown(room?.status),
      count: def.id === HQ_ID ? null : (room?.actors.length ?? 0) + (room?.overflow.length ?? 0),
    });
  }
  return out;
}
