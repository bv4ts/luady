import { RefusedError, ValidationError } from '../core/errors.js';

/** The machine-readable codes of the rooms API; the website shows them in plain words. */
export const ROOM_CONFLICTS = [
  'home_room_exists', 'position_taken', 'room_conflict', 'jira_exists', 'name_taken', 'room_exists',
] as const;
export type RoomConflict = (typeof ROOM_CONFLICTS)[number];

export const ROOM_INVALIDS = ['reserved_id', 'position_outside_grid', 'not_a_permutation', 'move_target'] as const;
export type RoomInvalid = (typeof ROOM_INVALIDS)[number];

/** HTTP 409 with one of ROOM_CONFLICTS as its `error.code`. */
export class RoomConflictError extends RefusedError {
  declare readonly code: RoomConflict;

  constructor(code: RoomConflict, message: string) {
    super(message);
    Object.defineProperty(this, 'code', { value: code, enumerable: true });
  }
}

/** HTTP 400 with one of ROOM_INVALIDS as its `error.code`. */
export class RoomInvalidError extends ValidationError {
  declare readonly code: RoomInvalid;

  constructor(code: RoomInvalid, message: string) {
    super(message);
    Object.defineProperty(this, 'code', { value: code, enumerable: true });
  }
}
