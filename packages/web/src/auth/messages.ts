import { isApiError, userMessage } from '../api/errors.js';

/** The hub's 429 says "Too many requests, retry in 42 seconds": the wait is the part after "retry in". */
function waitOf(message: string): string {
  const found = /retry in (.{1,40})$/.exec(message.trim());
  return found?.[1] ?? 'a minute';
}

/**
 * What a sign-in page says when the hub's sign-in limit is reached: what is happening, why it can come from another
 * program, and how long to wait.
 */
export function tooManyText(err: unknown): string | null {
  if (!isApiError(err) || err.status !== 429) return null;
  return `Too many sign-in attempts reached Luady from this computer in the last minute. Every program on this computer shares that limit. Wait ${waitOf(err.message)}, then try again.`;
}

/** A sign-in page's message for any failure: the limit in plain words, else the usual text. */
export function signInMessage(err: unknown): string {
  return tooManyText(err) ?? userMessage(err);
}
