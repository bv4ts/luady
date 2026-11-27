/**
 * What one add-on may cost the hub in disk and in notices (an add-on is bounded). Each is a named
 * constant so the numbers are easy to find and to change; the hub refuses, never deletes, when one is reached.
 */

const MIB = 1024 * 1024;

/** The biggest single file the website keeps for the owner. */
export const OUTBOX_FILE_MAX_BYTES = 250 * MIB;
/** All the outbox may hold at once (files older than 30 days are swept). */
export const OUTBOX_TOTAL_MAX_BYTES = 2 * 1024 * MIB;
export const OUTBOX_TOTAL_MAX_FILES = 500;

/** The biggest file an add-on may hand over with an owner message (copied into the brain inbox). */
export const INBOX_FILE_MAX_BYTES = 100 * MIB;

/** One `deliver` at a time per add-on; the next waits for the hub's `delivered`. */
export const DELIVER_IN_FLIGHT_MAX = 1;
/** And at most this many a minute per add-on. */
export const DELIVER_PER_MINUTE = 6;
export const DELIVER_WINDOW_MS = 60_000;

const mib = (bytes: number): string => `${Math.round(bytes / MIB)} MB`;
export const describeBytes = mib;
