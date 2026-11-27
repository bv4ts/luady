import { isTimeZone } from '@luady/shared';

/** This browser's own IANA zone, when Intl names one it knows; null otherwise. */
export function browserZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && isTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}
