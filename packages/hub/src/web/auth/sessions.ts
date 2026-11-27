import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../../core/contracts.js';
import { z } from 'zod';
import type { Clock, Db } from '../../core/contracts.js';
import { sha256Hex } from '../../core/ids.js';
import { isoNow } from '../../core/time.js';

export const SESSION_COOKIE = 'hub_sid';
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 60 * 60 * 1000;

export interface AppSession {
  /** The raw id carried by the cookie; auth_sessions stores only its sha256. */
  sid: string;
  csrf: string;
  createdAt: string;
  lastSeenAt: string;
}

/**
 * A new session's page key: 32 random bytes, handed out once in the sign-in answer and kept by the
 * website in this origin's storage. Only its sha256 is stored. It rotates with the session.
 */
export type NewSession = AppSession & { readonly pageKey: string };

/** How a session was made: a passkey sign-in or registration, a login link, a claim, or the preview's own sign-in. */
export type SessionVia = 'passkey' | 'link' | 'claim' | 'preview';

export interface SessionStoreDeps {
  db: Db;
  clock: Clock;
}

export interface SessionStore {
  /** A new session with its page key; the key is returned here once and never again. */
  create(): NewSession;
  /** Whether `key` is the page key of the live session `sid` (constant time; false for a session without one). */
  pageKeyMatches(sid: string, key: string | undefined): boolean;
  /** Validates (12 h absolute, 1 h idle) and extends the idle window; null when unknown or expired. */
  touch(sid: string): AppSession | null;
  /** Validates without extending the idle window (used by long-lived WebSockets). */
  peek(sid: string): AppSession | null;
  destroy(sid: string): void;
  /** Revokes every session except `keepSid` (used after a passkey is deleted); returns how many were removed. */
  destroyAllExcept(keepSid: string): number;
  purgeExpired(): number;
}

const RowSchema = z.object({
  sid: z.string(),
  csrf: z.string(),
  created_at: z.string(),
  last_seen_at: z.string(),
});
type Row = z.infer<typeof RowSchema>;

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function isLive(row: Row, nowMs: number): boolean {
  return (
    nowMs - Date.parse(row.created_at) < SESSION_ABSOLUTE_MS &&
    nowMs - Date.parse(row.last_seen_at) < SESSION_IDLE_MS
  );
}

function toSession(sid: string, row: Row, lastSeenAt: string): AppSession {
  return { sid, csrf: row.csrf, createdAt: row.created_at, lastSeenAt };
}

function statements(db: Db) {
  return {
    insert: db.prepare('INSERT INTO auth_sessions (sid, csrf, created_at, last_seen_at, page_key_sha256) VALUES (?, ?, ?, ?, ?)'),
    pageKey: db.prepare<[string], { page_key_sha256: string | null }>('SELECT page_key_sha256 FROM auth_sessions WHERE sid = ?'),
    select: db.prepare('SELECT sid, csrf, created_at, last_seen_at FROM auth_sessions WHERE sid = ?'),
    selectAll: db.prepare('SELECT sid, csrf, created_at, last_seen_at FROM auth_sessions'),
    markSeen: db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE sid = ?'),
    remove: db.prepare('DELETE FROM auth_sessions WHERE sid = ?'),
    removeOthers: db.prepare('DELETE FROM auth_sessions WHERE sid <> ?'),
  };
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const { db, clock } = deps;
  const sql = statements(db);

  const load = (sid: string): Row | null => {
    const parsed = RowSchema.safeParse(sql.select.get(sha256Hex(sid)));
    if (!parsed.success) return null;
    if (isLive(parsed.data, clock.now().getTime())) return parsed.data;
    sql.remove.run(parsed.data.sid);
    return null;
  };

  const purgeExpired = (): number => {
    const nowMs = clock.now().getTime();
    const expired = z.array(RowSchema).parse(sql.selectAll.all()).filter((row) => !isLive(row, nowMs));
    for (const row of expired) sql.remove.run(row.sid);
    return expired.length;
  };

  return {
    create() {
      purgeExpired();
      const sid = randomToken();
      const csrf = randomToken();
      const pageKey = randomToken();
      const now = isoNow(clock);
      sql.insert.run(sha256Hex(sid), csrf, now, now, sha256Hex(pageKey));
      return { sid, csrf, createdAt: now, lastSeenAt: now, pageKey };
    },
    pageKeyMatches(sid, key) {
      if (key === undefined || key === '' || load(sid) === null) return false;
      const stored = sql.pageKey.get(sha256Hex(sid))?.page_key_sha256 ?? null;
      return stored !== null && constantTimeEqual(stored, sha256Hex(key));
    },
    touch(sid) {
      const row = load(sid);
      if (row === null) return null;
      const now = isoNow(clock);
      sql.markSeen.run(now, row.sid);
      return toSession(sid, row, now);
    },
    peek(sid) {
      const row = load(sid);
      return row === null ? null : toSession(sid, row, row.last_seen_at);
    },
    destroy(sid) {
      sql.remove.run(sha256Hex(sid));
    },
    destroyAllExcept(keepSid) {
      return sql.removeOthers.run(sha256Hex(keepSid)).changes;
    },
    purgeExpired,
  };
}

function constantTimeEqual(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Constant-time comparison of the X-Hub-CSRF header with the session token. */
export function csrfMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  return constantTimeEqual(expected, provided);
}

export function sessionCookieOptions(): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    signed: true,
    maxAge: SESSION_ABSOLUTE_MS / 1000,
  };
}

export function setSessionCookie(reply: FastifyReply, session: AppSession): void {
  reply.setCookie(SESSION_COOKIE, session.sid, sessionCookieOptions());
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: true, sameSite: 'strict' });
}

/** The sid of a validly signed session cookie, or null (whether or not its page key came with it). */
export function signedSessionSid(request: FastifyRequest): string | null {
  const raw = request.cookies[SESSION_COOKIE];
  if (raw === undefined || raw === '') return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

/**
 * Rotation on login: the caller's current session ends and a fresh one, with a new page key, is issued. The old one is
 * found by the signed cookie too, so a session whose page key did not come along (`current` null) never outlives it.
 */
export function rotateSession(store: SessionStore, reply: FastifyReply, current: AppSession | null): NewSession {
  const old = current?.sid ?? signedSessionSid(reply.request);
  if (old !== null) store.destroy(old);
  const next = store.create();
  setSessionCookie(reply, next);
  return next;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** The web server's session store (web/server.ts), for createSessionWithPageKey. */
    luadySessions: SessionStore;
  }
}

/**
 * Signs the browser in: the caller's session, if any, ends; a new one is set as the cookie, and its
 * page key and CSRF token are returned for the answer body, the only place the key is ever sent. For the login link
 * and the preview's sign-in; the passkey routes use it too. Logged without any value.
 */
export function createSessionWithPageKey(reply: FastifyReply, via: SessionVia, log?: Logger): { pageKey: string; csrf: string } {
  const session = rotateSession(reply.server.luadySessions, reply, reply.request.luadySession);
  log?.info({ via }, 'auth: signed in');
  return { pageKey: session.pageKey, csrf: session.csrf };
}
