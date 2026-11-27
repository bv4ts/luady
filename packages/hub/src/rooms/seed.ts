import type { RoomImport } from '@luady/shared';
import type { Logger, RoomsService } from '../core/contracts.js';

/**
 * The one-time import of config.rooms. It runs on a start whose rooms table is empty and that has
 * never imported before, after the fleet and the config host rows exist (so each room passes the same host check as
 * one made on the website). There is no seed in code: without config.rooms the office starts empty.
 */
export function seedRooms(rooms: RoomsService, config: { readonly rooms?: readonly RoomImport[] | undefined }, log: Logger): number {
  if (config.rooms === undefined || rooms.seeded()) return 0;
  // Rooms made on the website already: the database owns them, and the file is never imported over them later.
  if (rooms.list().items.length > 0) {
    rooms.markSeeded();
    return 0;
  }
  const added = rooms.importRooms(config.rooms);
  rooms.markSeeded();
  log.info({ added, listed: config.rooms.length }, 'rooms: config.rooms imported once');
  return added;
}
