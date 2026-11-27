import { RefusedError } from '../core/errors.js';

/** The wire code of a call that needs the manager while it is off: HTTP 409 `manager_off`. */
export const MANAGER_OFF_CODE = 'manager_off';

/**
 * The manager is switched off, or still setting itself up: nothing reaches the self host. A RefusedError,
 * so every route answers 409; its code is `manager_off`.
 */
export class ManagerOffError extends RefusedError {
  override readonly code = MANAGER_OFF_CODE;

  constructor(message = 'The manager is off. Switch it on in Settings first.') {
    super(message);
  }
}
