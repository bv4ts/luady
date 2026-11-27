import type { Logger } from '../core/contracts.js';
import {
  HubError, NotFoundError, PinInvalidError, PinLockedError, PinNotSetError, QuestionClosedError, QuestionPendingError,
} from '../core/errors.js';
import { ManagerOffError } from '../luady/errors.js';
import {
  GENERIC_ERROR_NOTICE, MANAGER_OFF_NOTICE, PIN_NOT_SET_NOTICE, alreadyNotice, errorNotice, notFoundNotice, pinLockedNotice,
  waitingNotice, wrongPinNotice,
} from '../notify/format.js';

export interface ErrorContext {
  log: Logger;
  qid?: string;
  label?: string;
}

/** Maps an error to the owner-facing notice. Unexpected errors are logged and never leak their message. */
export function noticeForError(err: unknown, ctx: ErrorContext): string {
  if (err instanceof QuestionClosedError) return ctx.qid ? alreadyNotice(ctx.qid, err.state) : errorNotice(err.message);
  if (err instanceof QuestionPendingError) return waitingNotice(ctx.label ?? 'That session', err.qid);
  if (err instanceof PinInvalidError) return wrongPinNotice(err.remaining);
  if (err instanceof PinLockedError) return pinLockedNotice(err.until);
  if (err instanceof PinNotSetError) return PIN_NOT_SET_NOTICE;
  // The manager is optional: with it off, the owner hears so plainly, and nothing is kept for later.
  if (err instanceof ManagerOffError) return MANAGER_OFF_NOTICE;
  if (err instanceof NotFoundError) return notFoundNotice(err.message);
  if (err instanceof HubError) return errorNotice(err.message);
  ctx.log.error({ err }, 'inbound: unexpected error');
  return GENERIC_ERROR_NOTICE;
}
