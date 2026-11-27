import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PAGE_KEY_HEADER } from '@luady/shared';
import type { AccessIdentity, AccessVerifier, Logger } from '../../core/contracts.js';
import { AuthError } from '../../core/errors.js';
import { errorBody } from '../errors.js';
import { csrfMatches, signedSessionSid, type AppSession, type SessionStore } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Set by the auth chain once the access gate passes (the Cloudflare Access JWT in `cloudflare-access` mode; the
     * owner's label in `local` mode, which has no gate); null before that.
     */
    accessIdentity: AccessIdentity | null;
    /**
     * The validated app session for /api and /ws requests, or null. On /api, once the page-key rule is on, a session
     * whose request lacks its page key is null here too: no handler can act on a cookie alone.
     */
    luadySession: AppSession | null;
    /** True when a live session cookie came without its page key (the 401 then says page_key_required). */
    luadyPageKeyMissing: boolean;
  }
  interface FastifyInstance {
    /**
     * Whether setup is pending (no owner or no PIN yet): set by the setup routes when the hub has the setup module, null
     * otherwise. The chain then answers only sign-in and setup.
     */
    luadySetupPending: (() => boolean) | null;
  }
}

export const ACCESS_HEADER = 'cf-access-jwt-assertion';
export const ACCESS_COOKIE = 'CF_Authorization';
export const CSRF_HEADER = 'x-hub-csrf';

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

export interface AuthChainDeps {
  access: AccessVerifier;
  store: SessionStore;
  publicOrigin: string;
  log: Logger;
  /**
   * The page-key rule: when it answers true, every /api request must carry its session's page key in
   * `x-hub-key`; a cookie without it counts as no session. The live socket sends the key as its first message instead
   * (web/ws.ts). Absent or false: no page-key check.
   */
  pageKeyRequired?: () => boolean;
  /**
   * While it answers true (the setup step is claim or pin), a signed-in request may reach only sign-in, `/api/me` and
   * setup; every other /api route and every socket answers 409 setup_pending. Absent: no gate.
   */
  setupPending?: () => boolean;
}

export interface Denial {
  status: 401 | 403 | 409;
  code: 'auth' | 'forbidden' | 'page_key_required' | 'setup_pending';
  message: string;
}

const DENY_ACCESS: Denial = { status: 403, code: 'forbidden', message: 'Cloudflare Access token missing or invalid' };
const DENY_SESSION: Denial = { status: 401, code: 'auth', message: 'Login required' };
const DENY_PAGE_KEY: Denial = { status: 401, code: 'page_key_required', message: 'Sign in again on this page' };
const DENY_ORIGIN: Denial = { status: 403, code: 'forbidden', message: 'Origin not allowed' };
const DENY_CSRF: Denial = { status: 403, code: 'forbidden', message: 'CSRF token missing or invalid' };
const DENY_SETUP: Denial = { status: 409, code: 'setup_pending', message: 'Finish setting up Luady first: claim this install and choose a PIN.' };

export function pathOf(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** /api/** and /ws/** need an app session; static/SPA paths need only the access gate (none in `local` mode). */
export function isProtectedPath(path: string): boolean {
  return isUnder(path, '/api') || isUnder(path, '/ws');
}

/**
 * Google's OAuth redirect: cross-site, so the strict session cookie never arrives. Guarded by its single-use state (and,
 * in `cloudflare-access` mode only, by Access as well).
 */
export const GOOGLE_CALLBACK_ROUTE = '/api/google/callback';
/**
 * Opened from a chat link: guarded by a single-use code instead of the session cookie (and, in `cloudflare-access`
 * mode only, by Access as well).
 */
export const GOOGLE_CONNECT_ROUTE = '/api/google/connect';
/**
 * Wispr Flow's OAuth redirect: cross-site like Google's. Guarded by the single-use state from /wispr (and, in
 * `cloudflare-access` mode only, by Access as well).
 */
export const WISPR_CALLBACK_ROUTE = '/api/wispr/callback';

/** The first run: the setup state and the login link need no session (and no page key). */
export const SETUP_STATE_ROUTE = '/api/setup/state';
export const SETUP_LOGIN_ROUTE = '/api/setup/login';

/**
 * Session-exempt routes, matched on the route pattern (not the raw URL): /api/auth/*, /api/me, the Google and Wispr
 * callbacks, and the setup state and login link. A handler among them that needs a session reads request.luadySession,
 * which carries the page-key rule too.
 */
export function isSessionExempt(route: string | undefined): boolean {
  return route !== undefined && (route === '/api/me' || route.startsWith('/api/auth/') || route === GOOGLE_CALLBACK_ROUTE || route === GOOGLE_CONNECT_ROUTE
    || route === WISPR_CALLBACK_ROUTE || route === SETUP_STATE_ROUTE || route === SETUP_LOGIN_ROUTE);
}

export function isApiPath(path: string): boolean {
  return isUnder(path, '/api');
}

/** What a browser may reach while setup is pending: signing in, `/api/me` and the setup routes. */
export function isOpenDuringSetup(path: string): boolean {
  return path === '/api/me' || isUnder(path, '/api/auth') || isUnder(path, '/api/setup');
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

async function checkAccess(request: FastifyRequest, deps: AuthChainDeps): Promise<Denial | null> {
  const token = headerValue(request, ACCESS_HEADER) ?? request.cookies[ACCESS_COOKIE];
  try {
    request.accessIdentity = await deps.access.verify(token);
    return null;
  } catch (err) {
    if (!(err instanceof AuthError)) deps.log.warn({ err }, 'access verification failed unexpectedly');
    return DENY_ACCESS;
  }
}

function checkCsrf(request: FastifyRequest, session: AppSession | null, publicOrigin: string, ws: boolean): Denial | null {
  const mutating = MUTATING_METHODS.has(request.method);
  if (!mutating && !ws) return null;
  if (request.headers.origin !== publicOrigin) return DENY_ORIGIN;
  if (mutating && session !== null && !csrfMatches(session.csrf, headerValue(request, CSRF_HEADER))) return DENY_CSRF;
  return null;
}

/**
 * The page-key rule on one /api request: the session stands only with its key. Returns the session to use (null when
 * the key is missing or wrong) and whether a live cookie came without its key.
 */
function loadSession(request: FastifyRequest, deps: AuthChainDeps, api: boolean): { session: AppSession | null; missing: boolean } {
  const sid = signedSessionSid(request);
  if (sid === null) return { session: null, missing: false };
  if (deps.pageKeyRequired?.() !== true) return { session: deps.store.touch(sid), missing: false };
  // Outside /api (the sockets) the key comes later, as the first message: the cookie alone never extends the session.
  if (!api) return { session: deps.store.peek(sid), missing: false };
  // Checked before the touch: a cookie without its key never keeps the owner's session alive.
  if (deps.store.peek(sid) === null) return { session: null, missing: false };
  if (!deps.store.pageKeyMatches(sid, headerValue(request, PAGE_KEY_HEADER))) return { session: null, missing: true };
  return { session: deps.store.touch(sid), missing: false };
}

/**
 * Order: access gate (the Access JWT, or the local identity) → app session (with its page key on /api) →
 * CSRF/Origin. Returns the first denial, or null to continue.
 */
export async function runAuthChain(request: FastifyRequest, deps: AuthChainDeps): Promise<Denial | null> {
  const accessDenial = await checkAccess(request, deps);
  if (accessDenial !== null) return accessDenial;
  const route = request.routeOptions.url;
  const routePath = route ?? '';
  const path = pathOf(request.url);
  const protectedPath = isProtectedPath(path) || isProtectedPath(routePath);
  const api = isApiPath(path) || isApiPath(routePath);
  const { session, missing } = protectedPath ? loadSession(request, deps, api) : { session: null, missing: false };
  request.luadySession = session;
  request.luadyPageKeyMissing = missing;
  if (protectedPath && session === null && !isSessionExempt(route)) return missing ? DENY_PAGE_KEY : DENY_SESSION;
  // The matched route decides (the handler that would run); an unmatched path is judged by itself.
  if (protectedPath && !isOpenDuringSetup(route ?? path) && deps.setupPending?.() === true) return DENY_SETUP;
  const ws = isUnder(path, '/ws') || isUnder(routePath, '/ws');
  return checkCsrf(request, session, deps.publicOrigin, ws);
}

/** Must be registered after @fastify/cookie (its onRequest hook parses the cookies this one reads). */
export function registerAuthChain(app: FastifyInstance, deps: AuthChainDeps): void {
  app.decorateRequest('accessIdentity', null);
  app.decorateRequest('luadySession', null);
  app.decorateRequest('luadyPageKeyMissing', false);
  app.decorate('luadySetupPending', null);
  const chainDeps: AuthChainDeps = { ...deps, setupPending: deps.setupPending ?? (() => app.luadySetupPending?.() ?? false) };
  app.addHook('onRequest', async (request, reply) => {
    const denial = await runAuthChain(request, chainDeps);
    if (denial === null) return;
    return reply.code(denial.status).send(errorBody(denial.code, denial.message));
  });
}
