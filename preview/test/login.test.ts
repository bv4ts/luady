import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openMemoryDb } from '../../packages/hub/dist/db/open.js';
import { createSessionStore, SESSION_COOKIE } from '../../packages/hub/dist/web/auth/sessions.js';
import { createPreviewFleet } from '../fake-fleet.ts';
import { createLoginTokens, LOGIN_PATH, loginLink, type LoginTokens } from '../login-token.ts';
import { registerPreviewRoutes } from '../routes.ts';

const hubRequire = createRequire(new URL('../../packages/hub/package.json', import.meta.url));
const Fastify = hubRequire('fastify') as typeof import('fastify').default;
const fastifyCookie = hubRequire('@fastify/cookie') as typeof import('@fastify/cookie').default;

const clock = { now: () => new Date() };
const closers: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

interface Built {
  readonly app: FastifyInstance;
  readonly db: ReturnType<typeof openMemoryDb>;
  readonly tokens: LoginTokens;
  readonly keys: string[];
  readonly next: string[];
}

/** The preview routes on a Fastify with the hub's session store, as the hub's web server decorates it. */
async function build(): Promise<Built> {
  const db = openMemoryDb();
  const keys: string[] = [];
  const next: string[] = [];
  const tokens = createLoginTokens((token) => next.push(token));
  const app = Fastify();
  await app.register(fastifyCookie, { secret: 'a'.repeat(64), hook: 'onRequest' });
  app.decorate('luadySessions', createSessionStore({ db, clock }));
  app.decorateRequest('luadySession', null);
  registerPreviewRoutes(app, {
    fleet: createPreviewFleet({ clock: () => new Date() }),
    run: async () => '', scenarios: [], login: tokens, pageKey: (key) => keys.push(key),
  });
  await app.ready();
  closers.push(async () => {
    await app.close();
    db.close();
  });
  return { app, db, tokens, keys, next };
}

const sessions = (db: Built['db']): number => (db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get() as { n: number }).n;

describe('the preview sign-in', () => {
  it('has no open login route: without this run\'s token there is no session', async () => {
    const { app, db, keys } = await build();
    for (const url of [LOGIN_PATH, `${LOGIN_PATH}?t=`, `${LOGIN_PATH}?t=${'A'.repeat(43)}`, `${LOGIN_PATH}?token=x`]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(403);
      expect(res.headers['set-cookie'], url).toBeUndefined();
    }
    expect(sessions(db)).toBe(0);
    expect(keys).toEqual([]);
  });

  it('signs a browser in once with the token: a real session cookie, then home', async () => {
    const { app, db, tokens } = await build();
    const url = new URL(loginLink('http://localhost:7420', tokens.current()));
    const res = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/');
    const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
    const unsigned = app.unsignCookie(cookie?.value ?? '');
    expect(unsigned.valid).toBe(true);
    expect(createSessionStore({ db, clock }).peek(unsigned.value ?? '')).not.toBeNull();
    expect(sessions(db)).toBe(1);
    const again = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(again.statusCode).toBe(403);
    expect(sessions(db)).toBe(1);
  });

  it('hands the new session\'s page key to the page, and makes the next link', async () => {
    const { app, db, tokens, keys, next } = await build();
    const first = tokens.current();
    const res = await app.inject({ method: 'GET', url: `${LOGIN_PATH}?t=${first}` });
    expect(res.statusCode).toBe(302);
    expect(keys).toHaveLength(1);
    const sid = app.unsignCookie(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '').value ?? '';
    expect(createSessionStore({ db, clock }).pageKeyMatches(sid, keys[0])).toBe(true);
    expect(next).toEqual([tokens.current()]);
    expect(tokens.current()).not.toBe(first);
    const second = await app.inject({ method: 'GET', url: `${LOGIN_PATH}?t=${tokens.current()}` });
    expect(second.statusCode).toBe(302);
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('makes a different, unguessable token for every run', () => {
    const a = createLoginTokens().current();
    const b = createLoginTokens().current();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(createLoginTokens().take(undefined)).toBe(false);
  });
});
