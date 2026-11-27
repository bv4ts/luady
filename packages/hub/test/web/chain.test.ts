import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../../src/db/open.js';
import { isProtectedPath, isSessionExempt, pathOf, registerAuthChain } from '../../src/web/auth/chain.js';
import {
  createSessionStore,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  type AppSession,
  type SessionStore,
} from '../../src/web/auth/sessions.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { OWNER_EMAIL, PUBLIC_ORIGIN, SESSION_SECRET, signAccessToken, testAccessVerifier } from './fixtures.js';

type FakeClock = ReturnType<typeof createFakeClock>;

interface Rig {
  app: FastifyInstance;
  store: SessionStore;
  clock: FakeClock;
  token: string;
  cookie(session: AppSession): string;
}

const open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

async function rig(): Promise<Rig> {
  const clock = createFakeClock();
  const store = createSessionStore({ db: openMemoryDb(), clock });
  const app = Fastify();
  open.push(app);
  await app.register(fastifyCookie, { secret: SESSION_SECRET, hook: 'onRequest' });
  registerAuthChain(app, { access: await testAccessVerifier(), store, publicOrigin: PUBLIC_ORIGIN, log: silentLogger() });
  app.get('/index.html', async () => 'static');
  app.get('/api/me', async (request) => ({
    session: request.luadySession !== null,
    email: request.accessIdentity?.email ?? null,
  }));
  app.post('/api/auth/passkey/login/options', async (request) => ({ session: request.luadySession !== null }));
  app.get('/api/things', async () => ({ ok: true }));
  app.post('/api/things', async () => ({ ok: true }));
  app.get('/ws', async () => ({ ws: true }));
  await app.ready();
  return {
    app,
    store,
    clock,
    token: await signAccessToken(),
    cookie: (session) => `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(session.sid))}`,
  };
}

function jwt(token: string): Record<string, string> {
  return { 'cf-access-jwt-assertion': token };
}

describe('auth chain: Cloudflare Access', () => {
  it('rejects every request without an Access JWT with 403', async () => {
    const r = await rig();
    const requests = [
      { method: 'GET' as const, url: '/index.html' },
      { method: 'GET' as const, url: '/api/things' },
      { method: 'GET' as const, url: '/api/me' },
      { method: 'POST' as const, url: '/api/auth/passkey/login/options' },
    ];
    for (const request of requests) {
      const res = await r.app.inject({ ...request, headers: { origin: PUBLIC_ORIGIN } });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: { code: 'forbidden', message: 'Cloudflare Access token missing or invalid' } });
    }
  });

  it('rejects a JWT with the wrong audience, issuer, email or expiry with 403', async () => {
    const r = await rig();
    const bad = await Promise.all([
      signAccessToken({ aud: 'another-application' }),
      signAccessToken({ iss: 'https://evil.cloudflareaccess.com' }),
      signAccessToken({ email: 'intruder@example.com' }),
      signAccessToken({ expiresInSec: -60 }),
    ]);
    for (const token of bad) {
      expect((await r.app.inject({ url: '/index.html', headers: jwt(token) })).statusCode).toBe(403);
    }
  });

  it('accepts the CF_Authorization cookie when the header is absent', async () => {
    const r = await rig();
    const res = await r.app.inject({ url: '/index.html', headers: { cookie: `CF_Authorization=${r.token}` } });
    expect(res.statusCode).toBe(200);
  });

  it('serves static paths with only the Access JWT', async () => {
    const r = await rig();
    const res = await r.app.inject({ url: '/index.html', headers: jwt(r.token) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('static');
  });
});

describe('auth chain: app session', () => {
  it('requires an app session for /api routes (401 auth)', async () => {
    const r = await rig();
    const res = await r.app.inject({ url: '/api/things', headers: jwt(r.token) });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'auth', message: 'Login required' } });
  });

  it('lets /api/me through without a session and records the verified identity', async () => {
    const r = await rig();
    const res = await r.app.inject({ url: '/api/me', headers: jwt(r.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ session: false, email: OWNER_EMAIL });
  });

  it('accepts a valid signed session cookie', async () => {
    const r = await rig();
    const res = await r.app.inject({ url: '/api/things', headers: { ...jwt(r.token), cookie: r.cookie(r.store.create()) } });
    expect(res.statusCode).toBe(200);
  });

  it('rejects an unsigned or tampered session cookie with 401', async () => {
    const r = await rig();
    const session = r.store.create();
    const unsigned = await r.app.inject({ url: '/api/things', headers: { ...jwt(r.token), cookie: `${SESSION_COOKIE}=${session.sid}` } });
    expect(unsigned.statusCode).toBe(401);
    const signed = decodeURIComponent(r.cookie(session).slice(SESSION_COOKIE.length + 1));
    const tampered = `${SESSION_COOKIE}=${encodeURIComponent(`${signed.slice(0, -2)}xx`)}`;
    expect((await r.app.inject({ url: '/api/things', headers: { ...jwt(r.token), cookie: tampered } })).statusCode).toBe(401);
  });

  it('expires the session after one idle hour', async () => {
    const r = await rig();
    const session = r.store.create();
    r.clock.advance(SESSION_IDLE_MS);
    const res = await r.app.inject({ url: '/api/things', headers: { ...jwt(r.token), cookie: r.cookie(session) } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'auth', message: 'Login required' } });
  });
});

describe('auth chain: CSRF and Origin', () => {
  it('mutating requests need X-Hub-CSRF bound to the session', async () => {
    const r = await rig();
    const mine = r.store.create();
    const other = r.store.create();
    const base = { ...jwt(r.token), cookie: r.cookie(mine), origin: PUBLIC_ORIGIN };
    const post = (headers: Record<string, string>) =>
      r.app.inject({ method: 'POST', url: '/api/things', headers, payload: {} });
    const missing = await post(base);
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toEqual({ error: { code: 'forbidden', message: 'CSRF token missing or invalid' } });
    expect((await post({ ...base, 'x-hub-csrf': 'wrong' })).statusCode).toBe(403);
    expect((await post({ ...base, 'x-hub-csrf': other.csrf })).statusCode).toBe(403);
    expect((await post({ ...base, 'x-hub-csrf': mine.csrf })).statusCode).toBe(200);
  });

  it('mutating requests need Origin equal to the public origin', async () => {
    const r = await rig();
    const session = r.store.create();
    const base = { ...jwt(r.token), cookie: r.cookie(session), 'x-hub-csrf': session.csrf };
    const post = (headers: Record<string, string>) =>
      r.app.inject({ method: 'POST', url: '/api/things', headers, payload: {} });
    const evil = await post({ ...base, origin: 'https://evil.example' });
    expect(evil.statusCode).toBe(403);
    expect(evil.json()).toEqual({ error: { code: 'forbidden', message: 'Origin not allowed' } });
    expect((await post(base)).statusCode).toBe(403);
    expect((await post({ ...base, origin: `${PUBLIC_ORIGIN}.evil.example` })).statusCode).toBe(403);
  });

  it('checks the session before CSRF and Origin (401 wins)', async () => {
    const r = await rig();
    const res = await r.app.inject({
      method: 'POST',
      url: '/api/things',
      headers: { ...jwt(r.token), origin: 'https://evil.example' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('auth routes always check Origin, and check CSRF once a session is present', async () => {
    const r = await rig();
    const session = r.store.create();
    const url = '/api/auth/passkey/login/options';
    expect((await r.app.inject({ method: 'POST', url, headers: jwt(r.token), payload: {} })).statusCode).toBe(403);
    const anonymous = await r.app.inject({ method: 'POST', url, headers: { ...jwt(r.token), origin: PUBLIC_ORIGIN }, payload: {} });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toEqual({ session: false });
    const withSession = { ...jwt(r.token), origin: PUBLIC_ORIGIN, cookie: r.cookie(session) };
    expect((await r.app.inject({ method: 'POST', url, headers: withSession, payload: {} })).statusCode).toBe(403);
    const ok = await r.app.inject({ method: 'POST', url, headers: { ...withSession, 'x-hub-csrf': session.csrf }, payload: {} });
    expect(ok.json()).toEqual({ session: true });
  });

  it('WebSocket paths require the public Origin', async () => {
    const r = await rig();
    const headers = { ...jwt(r.token), cookie: r.cookie(r.store.create()) };
    expect((await r.app.inject({ url: '/ws', headers })).statusCode).toBe(403);
    expect((await r.app.inject({ url: '/ws', headers: { ...headers, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await r.app.inject({ url: '/ws', headers: { ...headers, origin: PUBLIC_ORIGIN } })).statusCode).toBe(200);
  });

  it('classifies paths and route patterns', () => {
    expect(pathOf('/api/things?x=1')).toBe('/api/things');
    expect(isProtectedPath('/api')).toBe(true);
    expect(isProtectedPath('/api/x')).toBe(true);
    expect(isProtectedPath('/ws/terminal')).toBe(true);
    expect(isProtectedPath('/apix')).toBe(false);
    expect(isProtectedPath('/index.html')).toBe(false);
    expect(isSessionExempt('/api/me')).toBe(true);
    expect(isSessionExempt('/api/auth/logout')).toBe(true);
    expect(isSessionExempt('/api/wispr/callback')).toBe(true);
    expect(isSessionExempt('/api/meta')).toBe(false);
    expect(isSessionExempt(undefined)).toBe(false);
  });
});
