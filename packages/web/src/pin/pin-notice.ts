import { ApiError } from '../api/errors.js';
import { ownerTime } from '../lib/format.js';

export type PinNoticeKind = 'required' | 'invalid' | 'locked' | 'not_set';

export interface PinNotice {
  readonly kind: PinNoticeKind;
  readonly message: string;
}

/** `remaining` comes only with pin_invalid. The third wrong PIN sends 0 and starts the lockout. */
function invalidNotice(remaining: number | undefined): PinNotice {
  if (remaining === 0) return { kind: 'locked', message: 'Wrong PIN. PIN entry is now locked. Try again later.' };
  if (remaining === undefined) return { kind: 'invalid', message: 'Wrong PIN. Try again.' };
  return { kind: 'invalid', message: `Wrong PIN — ${remaining} ${remaining === 1 ? 'try' : 'tries'} left.` };
}

/** `until` comes only with pin_locked. */
function lockedNotice(until: string | undefined): PinNotice {
  const at = until === undefined ? null : ownerTime(until);
  const message = at ? `Too many wrong PINs. Locked until ${at} (owner time).` : 'Too many wrong PINs. PIN entry is locked for now.';
  return { kind: 'locked', message };
}

/** Reads only the error body fields (via ApiError.details), never the message text. */
export function pinNotice(err: unknown): PinNotice | null {
  if (!(err instanceof ApiError)) return null;
  switch (err.code) {
    case 'pin_required':
      return { kind: 'required', message: 'This action needs your PIN.' };
    case 'pin_invalid':
      return invalidNotice(err.details.remaining);
    case 'pin_locked':
      return lockedNotice(err.details.until);
    case 'pin_not_set':
      return { kind: 'not_set', message: 'No PIN is set yet. Reload Luady to finish setup.' };
    default:
      return null;
  }
}
