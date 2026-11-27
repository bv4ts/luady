import { describe, expect, it, vi } from 'vitest';
import { PAGE_KEY_HEADER } from '@luady/shared';
import { openMemoryDb as openDbForStore } from '../../src/db/open.js';
import { createPageKeyCheck } from '../../src/web/auth/page-key.js';
import {
  SESSION_COOKIE, SESSION_IDLE_MS, createSessionStore, createSessionWithPageKey, type NewSession, type SessionStore,
} from '../../src/web/auth/sessions.js';
import type { WebServerOptions } from '../../src/web/context.js';
import type { WebDeps } from '../../src/web/server.js';
import { call, cookieFrom, harnessFactory, type Harness, type LoggedIn } from './helpers.js';
import { connectWs, listen, sleep, wsHeaders } from './ws-helpers.js';

const harness = harnessFactory();
const FAST: Partial<WebServerOptions> = { wsSessionCheckMs: 60_000, transcriptDebounceMs: 20, transcriptPollMs: 60_000, wsAuthTimeoutMs: 150 };

interface Keyed {
  readonly h: Harness;
  readonly store: SessionStore;
  /** A signed-in session with its page key, as a sign-in answer hands it out. */
  session(): LoggedIn & { pageKey: string };
}

/** The hub's rule (wire/core.ts): the page key on, checked against the harness database's own sessions. */
async function keyed(over: Partial<WebDeps> = {}): Promise<Keyed> {
  let store: SessionStore | null = null;
  const h = await harness({
    ...over,
    pageKey: { required: () => true, matches: (sid, key) => store?.pageKeyMatches(sid, key) ?? false },
  }, FAST);
  const own = createSessionStore({ db: h.deps.db, clock: h.clock });
  store = own;
  return {
    h,
    store: own,
    session: () => {
      const made: NewSession = own.create();
      return { sid: made.sid, csrf: made.csrf, pageKey: made.pageKey, cookie: `${SESSION_COOKIE}=${encodeURIComponent(h.app.signCookie(made.sid))}` };
    },
  };
}

const withKey = (key: string): { headers: Record<string, string> } => ({ headers: { [PAGE_KEY_HEADER]: key } });

describe('the page key on /api', () => {
  it('cookie and CSRF but no x-hub-key: 401 page_key_required on /api/overview, /api/me and /api/auth/passkeys', async () => {
    const { h, session } = await keyed();
    const signed = session();
    for (const url of ['/api/overview', '/api/me', '/api/auth/passkeys']) {
      const res = await call(h, 'GET', url, undefined, { session: signed, csrf: signed.csrf });
      expect(res.statusCode, url).toBe(401);
      expect(res.json(), url).toEqual({ error: { code: 'page_key_required', message: 'Sign in again on this page' } });
    }
  });

  it('the right key gives 200 on the same three; a wrong key, or the key of another session, gives 401', async () => {
    const { h, session } = await keyed();
    const signed = session();
    const other = session();
    for (const url of ['/api/overview', '/api/me', '/api/auth/passkeys']) {
      expect((await call(h, 'GET', url, undefined, { session: signed, ...withKey(signed.pageKey) })).statusCode, url).toBe(200);
      expect((await call(h, 'GET', url, undefined, { session: signed, ...withKey('w'.repeat(43)) })).statusCode, url).toBe(401);
      expect((await call(h, 'GET', url, undefined, { session: signed, ...withKey(other.pageKey) })).statusCode, url).toBe(401);
    }
  });

  it('/api/me never contains the key, and only its sha256 is stored', async () => {
    const { h, session } = await keyed();
    const signed = session();
    const me = await call(h, 'GET', '/api/me', undefined, { session: signed, ...withKey(signed.pageKey) });
    expect(me.statusCode).toBe(200);
    expect(me.body).not.toContain(signed.pageKey);
    expect(me.json()).toMatchObject({ csrf: signed.csrf });
    const stored = h.deps.db.prepare('SELECT page_key_sha256 AS k FROM auth_sessions').all() as Array<{ k: string }>;
    expect(stored.map((row) => row.k)).not.toContain(signed.pageKey);
    expect(stored.every((row) => /^[a-f0-9]{64}$/.test(row.k))).toBe(true);
  });

  it('routes the chain exempts but which need a session need the key too: deleting a passkey, changing the PIN', async () => {
    const { h, session } = await keyed();
    const signed = session();
    vi.mocked(h.deps.pin.isSet).mockReturnValue(true);
    const remove = await call(h, 'POST', '/api/auth/passkeys/Y3JlZA/delete', { pin: '123456' }, { session: signed });
    expect(remove.statusCode).toBe(401);
    expect(remove.json()).toMatchObject({ error: { code: 'page_key_required' } });
    const pin = await call(h, 'POST', '/api/auth/pin', { newPin: '654321', currentPin: '123456' }, { session: signed });
    expect(pin.statusCode).toBe(401);
    expect(h.deps.pin.verify).not.toHaveBeenCalled();
    expect(h.deps.pin.set).not.toHaveBeenCalled();
  });

  it('a session from before the upgrade (no stored key) is refused whatever key it sends', async () => {
    const { h, session } = await keyed();
    const signed = session();
    h.deps.db.prepare('UPDATE auth_sessions SET page_key_sha256 = NULL').run();
    expect((await call(h, 'GET', '/api/overview', undefined, { session: signed, ...withKey(signed.pageKey) })).statusCode).toBe(401);
  });

  it('a cookie without its key never keeps the session alive (no touch), so it still expires on time', async () => {
    const { h, session } = await keyed();
    const signed = session();
    h.clock.advance(SESSION_IDLE_MS - 60_000);
    expect((await call(h, 'GET', '/api/overview', undefined, { session: signed })).statusCode).toBe(401);
    h.clock.advance(120_000);
    expect((await call(h, 'GET', '/api/overview', undefined, { session: signed, ...withKey(signed.pageKey) })).statusCode).toBe(401);
  });

  it('the passkey sign-in answer is the only place the key is sent, and the setup state needs none', () => {
    // The sign-in answers are covered in routes-auth.test.ts; this pins the store contract they rely on.
    const store = createSessionStore({ db: openDbForStore(), clock: { now: () => new Date('2026-11-21T08:00:00.000Z') } });
    const made = store.create();
    expect(made.pageKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.pageKeyMatches(made.sid, made.pageKey)).toBe(true);
    expect(store.pageKeyMatches(made.sid, undefined)).toBe(false);
    expect(store.pageKeyMatches(made.sid, '')).toBe(false);
    expect(store.touch(made.sid)).not.toHaveProperty('pageKey');
    expect(createPageKeyCheck(store).required()).toBe(true);
  });
});

describe('the page key on /ws', () => {
  it('a socket without auth first receives no message at all, not even a broadcast, then closes with 4401', async () => {
    const { h, session } = await keyed();
    const signed = session();
    const url = `${await listen(h)}/ws`;
    const probe = await connectWs(url, wsHeaders(h, signed));
    const received: unknown[] = [];
    probe.ws.on('message', (data) => received.push(String(data)));
    h.deps.bus.emit('setup.changed', { state: { step: 'rooms', claimed: true, authMode: 'local', remote: false, skipped: [] } });
    h.deps.bus.emit('manager.status', { state: 'running', since: '2026-11-21T08:00:00.000Z', claudeSessionId: null, queued: 0 });
    const closed = await probe.closed;
    expect(closed.code).toBe(4401);
    expect(received).toEqual([]);
    expect(h.deps.presence.connect).not.toHaveBeenCalled();
  });

  it('closes with 4401 at once, having sent nothing, on a wrong key or a garbage first frame', async () => {
    const { h, session } = await keyed();
    const signed = session();
    const url = `${await listen(h)}/ws`;
    for (const frame of [JSON.stringify({ type: 'auth', key: 'x'.repeat(43) }), 'not json at all', JSON.stringify({ type: 'ping' })]) {
      const probe = await connectWs(url, wsHeaders(h, signed));
      const received: unknown[] = [];
      probe.ws.on('message', (data) => received.push(String(data)));
      probe.ws.send(frame);
      expect((await probe.closed).code, frame).toBe(4401);
      expect(received, frame).toEqual([]);
    }
  });

  it('the right key lets the socket in: hello first, then the events; presence counts it only now', async () => {
    const { h, session } = await keyed();
    const signed = session();
    const url = `${await listen(h)}/ws`;
    const probe = await connectWs(url, wsHeaders(h, signed));
    await sleep(20);
    expect(h.deps.presence.connect).not.toHaveBeenCalled();
    probe.ws.send(JSON.stringify({ type: 'auth', key: signed.pageKey }));
    expect(await probe.next()).toMatchObject({ type: 'hello' });
    expect(h.deps.presence.connect).toHaveBeenCalledTimes(1);
    h.deps.bus.emit('setup.changed', { state: { step: 'done', claimed: true, authMode: 'local', remote: false, skipped: [] } });
    expect(await probe.next()).toMatchObject({ type: 'setup.changed' });
    probe.ws.close();
  });

  it('a socket upgrade with the cookie alone never extends the session (no touch before the key)', async () => {
    const { h, session } = await keyed();
    const signed = session();
    const url = `${await listen(h)}/ws`;
    h.clock.advance(SESSION_IDLE_MS - 60_000);
    const probe = await connectWs(url, wsHeaders(h, signed));
    expect((await probe.closed).code).toBe(4401);
    h.clock.advance(120_000);
    expect((await call(h, 'GET', '/api/me', undefined, { session: signed, ...withKey(signed.pageKey) })).statusCode).toBe(401);
  });

  it('the key of another session does not open this socket', async () => {
    const { h, session } = await keyed();
    const signed = session();
    const other = session();
    const url = `${await listen(h)}/ws`;
    const probe = await connectWs(url, wsHeaders(h, signed));
    probe.ws.send(JSON.stringify({ type: 'auth', key: other.pageKey }));
    expect((await probe.closed).code).toBe(4401);
  });
});


describe('createSessionWithPageKey (for the login link and the preview sign-in)', () => {
  it('rotates the session, sets the cookie and answers the page key once; that key then opens /api, the old cookie no longer does', async () => {
    const { h, session } = await keyed();
    const before = session();
    // A route of the login-link kind: session-exempt under /api/auth/, so it runs with or without a session.
    h.app.post('/api/auth/test-link', async (_request, reply) => createSessionWithPageKey(reply, 'link', h.deps.log));
    const res = await call(h, 'POST', '/api/auth/test-link', {}, { session: before, ...withKey(before.pageKey) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { pageKey: string; csrf: string };
    expect(body.pageKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.pageKey).not.toBe(before.pageKey);
    const fresh = { sid: '', csrf: body.csrf, cookie: cookieFrom(res) };
    expect((await call(h, 'GET', '/api/me', undefined, { session: fresh, ...withKey(body.pageKey) })).statusCode).toBe(200);
    expect((await call(h, 'GET', '/api/me', undefined, { session: before, ...withKey(before.pageKey) })).statusCode).toBe(401);
  });

  it('a sign-in whose old cookie came without its page key still ends that old session', async () => {
    const { h, store, session } = await keyed();
    const before = session();
    h.app.post('/api/auth/test-link', async (_request, reply) => createSessionWithPageKey(reply, 'link', h.deps.log));
    const res = await call(h, 'POST', '/api/auth/test-link', {}, { session: before });
    expect(res.statusCode).toBe(200);
    expect(store.peek(before.sid)).toBeNull();
  });
});

describe('signing out ends the session the signed cookie names', () => {
  it('with its page key or without it', async () => {
    const { h, store, session } = await keyed();
    const keyed1 = session();
    expect((await call(h, 'POST', '/api/auth/logout', {}, { session: keyed1, ...withKey(keyed1.pageKey) })).statusCode).toBe(200);
    expect(store.peek(keyed1.sid)).toBeNull();
    const bare = session();
    const other = session();
    expect((await call(h, 'POST', '/api/auth/logout', {}, { session: bare })).statusCode).toBe(200);
    expect(store.peek(bare.sid)).toBeNull();
    expect(store.peek(other.sid)).not.toBeNull();
  });

  it('a cookie with a bad signature ends nothing', async () => {
    const { h, store, session } = await keyed();
    const signed = session();
    const forged = { ...signed, cookie: `${SESSION_COOKIE}=${encodeURIComponent(`${signed.sid}.bad-signature`)}` };
    expect((await call(h, 'POST', '/api/auth/logout', {}, { session: forged })).statusCode).toBe(200);
    expect(store.peek(signed.sid)).not.toBeNull();
  });
});
