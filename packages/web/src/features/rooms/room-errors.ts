import { isApiError, userMessage } from '../../api/errors.js';

/**
 * The rooms API's refusals in plain words, each saying what to do next. No code or id is ever shown.
 * `stale` marks the one refusal whose fix is to load the room again (another screen changed it).
 */
export interface RoomProblem {
  readonly text: string;
  readonly stale: boolean;
}

const WORDS: Readonly<Record<string, string>> = Object.freeze({
  room_conflict: 'This room was changed on another screen. Load the newest version, then make your change again.',
  name_taken: 'Another room already has this name. Pick a different name.',
  room_exists: 'A room with this name existed before. Pick a different name.',
  reserved_id: 'That name is reserved for the office itself. Pick a different name.',
  home_room_exists: 'This server already has its own room. Pick another server, or make a project room for it instead.',
  position_taken: 'That spot on the map was just taken. Pick another free spot, or let the office choose one.',
  position_outside_grid: 'That spot is outside the office. Pick a free spot inside it, or let the office choose one.',
  not_a_permutation: 'The list of rooms changed while you were sorting it. Look at the newest list and try again.',
  move_target: 'Pick the room that should get this room\'s links and Jira board.',
  jira_exists: 'The room you picked already has a Jira board. Pick another room for it, or disconnect this one.',
  pin_required: 'Enter your PIN to disconnect the Jira board.',
  pin_invalid: 'That PIN is not right. Try again.',
  pin_locked: 'Too many wrong PINs. Wait a few minutes, then try again.',
  pin_not_set: 'Set a PIN in Settings first, then try again.',
  not_found: 'This room is gone: it was removed on another screen.',
  invalid_request: 'Some of the fields need a fix. Check the marked fields and try again.',
});

/** What a failed room write says to the owner. */
export function roomProblem(err: unknown): RoomProblem {
  if (isApiError(err)) {
    const words = Object.hasOwn(WORDS, err.code) ? WORDS[err.code] : undefined;
    if (words !== undefined) return { text: words, stale: err.code === 'room_conflict' };
    if (err.status === 404) return { text: WORDS.not_found ?? '', stale: false };
    // The hub's own check failed (a rule the form did not catch): its sentence is plain words already.
    if (err.code === 'validation') return { text: `${err.message}. Change it and try again.`.replace('..', '.'), stale: false };
  }
  return { text: userMessage(err), stale: false };
}
