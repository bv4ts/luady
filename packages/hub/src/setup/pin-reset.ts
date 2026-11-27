import type { Db } from '../core/contracts.js';
import { clearPinState } from '../security/pin.js';
import { revokeUnusedCodes } from '../security/setup-codes.js';

export interface PinResetResult {
  /** Sign-ins ended: every browser signs in again. */
  readonly sessionsEnded: number;
  /** Setup codes and login links not used yet, now void. */
  readonly codesEnded: number;
}

/**
 * The PIN reset: `luady pin reset` in the terminal is the only way in; there is no web route for it.
 * In one transaction it clears the PIN (and its lockout), ends every session, and voids every unused setup code and
 * login link, so the next PIN needs a new setup code. Passkeys stay. It runs over the database, with or without the hub.
 */
export function resetPin(db: Db): PinResetResult {
  return db.transaction((): PinResetResult => {
    clearPinState(db);
    const sessionsEnded = db.prepare('DELETE FROM auth_sessions').run().changes;
    const codesEnded = revokeUnusedCodes(db);
    return { sessionsEnded, codesEnded };
  })();
}
