import { createHash, timingSafeEqual } from 'node:crypto';

const BEARER = 'Bearer ';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time bearer check: both sides are hashed so the compared buffers always have equal length. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  if (token.length === 0 || typeof header !== 'string' || !header.startsWith(BEARER)) return false;
  return timingSafeEqual(digest(header.slice(BEARER.length)), digest(token));
}
