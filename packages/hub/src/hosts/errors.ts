import { CtlError, RefusedError, ValidationError } from '../core/errors.js';
import { ForbiddenError, TooManyRequestsError } from '../web/errors.js';

/**
 * The machine-readable codes of the hosts API. The website turns each into a sentence that says what to do next
 * (features/hosts/messages.ts); the hub's own messages stay short and never carry remote output.
 */
export const HOST_CONFLICTS = [
  'host_exists', 'local_exists', 'host_from_config', 'host_removed', 'host_not_pinned', 'host_is_local', 'scan_needed',
  'fingerprint_changed', 'job_running', 'jobs_busy', 'fleet_from_invalid', 'host_offline', 'host_busy',
] as const;
export type HostConflict = (typeof HOST_CONFLICTS)[number];

export const HOST_INVALIDS = [
  'address_refused', 'folder_missing', 'folder_outside_home', 'folder_parent_missing', 'not_a_folder', 'folder_invalid', 'local_fields',
  'local_unsupported',
] as const;
export type HostInvalid = (typeof HOST_INVALIDS)[number];

export const HOST_REACH = ['unreachable', 'no_ssh'] as const;
export type HostReach = (typeof HOST_REACH)[number];

/** HTTP 409 with one of HOST_CONFLICTS as its code. */
export class HostConflictError extends RefusedError {
  declare readonly code: HostConflict;

  constructor(code: HostConflict, message: string) {
    super(message);
    Object.defineProperty(this, 'code', { value: code, enumerable: true });
  }
}

/** HTTP 400 with one of HOST_INVALIDS as its code. */
export class HostInvalidError extends ValidationError {
  declare readonly code: HostInvalid;

  constructor(code: HostInvalid, message: string) {
    super(message);
    Object.defineProperty(this, 'code', { value: code, enumerable: true });
  }
}

/** HTTP 502: the server could not be reached, or what answered is not an SSH server. Deliberately vague. */
export class HostReachError extends CtlError {
  declare readonly code: HostReach;

  constructor(code: HostReach, message: string) {
    super(code, message, -1);
  }
}

/** HTTP 403: a hosts route needs the PIN (`pin_required`) or this host's grant (`grant_required`). */
export class HostAccessError extends ForbiddenError {
  constructor(code: 'pin_required' | 'grant_required', message: string) {
    super(code, message);
  }
}

/** HTTP 429 for the hosts buckets, with Retry-After. */
export class HostRateError extends TooManyRequestsError {}
