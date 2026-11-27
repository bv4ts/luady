import { useStore } from '../../state/store.js';
import { roomLookup, type RoomLookup } from './room-lookup.js';

export type { RoomLookup } from './room-lookup.js';
export { hqName, roomLookup } from './room-lookup.js';

/** The office's rooms as names and colours (room-lookup.ts), from the store; a new object only when the rooms change. */
export function useRooms(): RoomLookup {
  return roomLookup(useStore().state.rooms);
}
