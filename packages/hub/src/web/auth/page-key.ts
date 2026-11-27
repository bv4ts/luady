import type { FastifyRequest } from 'fastify';
import { AuthError } from '../../core/errors.js';
import type { AppSession, SessionStore } from './sessions.js';

/** 401 `page_key_required`: a live session cookie came without its page key; the page signs in again. */
export class PageKeyRequiredError extends AuthError {
  override readonly code = 'page_key_required';

  constructor() {
    super('Sign in again on this page');
  }
}

/**
 * The session of a request whose route is session-exempt but needs one (`/api/me`, the passkey list, a PIN change):
 * the chain left it null when the cookie is missing or came without its page key, and this says which.
 */
export function requireSessionOf(request: FastifyRequest, message = 'Login required'): AppSession {
  if (request.luadySession !== null) return request.luadySession;
  throw request.luadyPageKeyMissing ? new PageKeyRequiredError() : new AuthError(message);
}

/** What the live socket checks (web/server.ts PageKeyCheck), over the session store; always on in the hub (wire/core.ts). */
export function createPageKeyCheck(store: Pick<SessionStore, 'pageKeyMatches'>): { required(): boolean; matches(sid: string, key: string): boolean } {
  return { required: () => true, matches: (sid, key) => store.pageKeyMatches(sid, key) };
}
