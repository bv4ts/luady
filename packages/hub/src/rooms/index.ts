/**
 * Rooms in the hub: the rooms table, its checks, the cascade of a removal, the one-time import of
 * config.rooms, the preview, ROOMS.auto.md and the `rooms.changed` event. For the hosts module: the service's
 * `roomsOfHost(host)` and `deleteRoomsOfHost(host, 'delete' | 'keep')`.
 */
export { ROOMS_CHANGED_MIN_MS, createRoomsService, type RoomsDeps } from './service.js';
export { seedRooms } from './seed.js';
export { ROOM_CONFLICTS, ROOM_INVALIDS, RoomConflictError, RoomInvalidError, type RoomConflict, type RoomInvalid } from './errors.js';
export { ROOMS_SEEDED_KEY, type RoomRecord } from './repo.js';
export { ROOM_POSITION_LIMIT } from './validate.js';
export { renderRoomsAuto, roomsText, writeRoomsAuto } from './rooms-file.js';
