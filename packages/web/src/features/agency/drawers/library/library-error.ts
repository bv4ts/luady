import { isApiError, userMessage } from '../../../../api/errors.js';

/** A hub that has no library yet (older hub 404, stub hub 501). */
export const LIBRARY_NOT_READY = 'The library needs the next hub update.';

/** A library or knowledge-base error in the owner's words. */
export function libraryError(err: unknown): string {
  return isApiError(err) && (err.status === 404 || err.status === 501) ? LIBRARY_NOT_READY : userMessage(err);
}
