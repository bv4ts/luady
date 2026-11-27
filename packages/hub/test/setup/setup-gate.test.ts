import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_WEB_OPTIONS, type RouteModule, type WebContext } from '../../src/web/context.js';
import { OPTIONAL_ROUTE_MODULES, ROUTE_MODULES } from '../../src/web/routes/index.js';
import { harnessFactory, makeDirs, testConfig } from '../web/helpers.js';
import { localHub, type LocalHub } from './local-hub.js';

const harness = harnessFactory();

interface RouteEntry {
  readonly method: string;
  readonly url: string;
}

/** Anything, at any depth: what a route module may read from its context while it registers. */
const anything: unknown = new Proxy(function stand() {}, {
  get: (_target, property) => (property === Symbol.toPrimitive ? () => '' : property === 'then' ? undefined : anything),
  apply: () => anything,
});

/**
 * Every route the website's server can register (the inventory, not a hand-picked route): each route module is run
 * against a recorder in place of Fastify.
 */
function routeInventory(): RouteEntry[] {
  const found: RouteEntry[] = [];
  const verbs = ['get', 'post', 'put', 'delete', 'patch'];
  const recorder = new Proxy({}, {
    get: (_target, property) => {
      if (typeof property === 'string' && verbs.includes(property)) {
        return (url: string) => { found.push({ method: property.toUpperCase(), url }); };
      }
      if (property === 'route') {
        return (opts: { method: string | string[]; url: string }) => {
          for (const method of [opts.method].flat()) found.push({ method, url: opts.url });
        };
      }
      return () => anything;
    },
  }) as unknown as FastifyInstance;
  const config = testConfig(makeDirs());
  const deps = new Proxy({}, { get: (_target, property) => (property === 'config' ? config : anything) });
  const ctx = { deps, store: anything, passkeys: anything, webauthn: anything, options: DEFAULT_WEB_OPTIONS } as unknown as WebContext;
  const modules: RouteModule[] = [...ROUTE_MODULES, ...OPTIONAL_ROUTE_MODULES.map((module) => module.register)];
  for (const register of modules) register(recorder, ctx);
  return found;
}

const OPEN = (url: string): boolean => url === '/api/me' || url.startsWith('/api/auth/') || url.startsWith('/api/setup/');
const GATED = (url: string): boolean => (url.startsWith('/api/') || url === '/ws' || url.startsWith('/ws/')) && !OPEN(url);

function concrete(url: string): string {
  return url.replace(/:[A-Za-z]+/g, 'x').replace(/\*/g, 'x');
}

async function sendEach(hub: LocalHub, routes: readonly RouteEntry[]) {
  const out: Array<RouteEntry & { status: number; code: string | null }> = [];
  for (const route of routes) {
    // A fresh session each time: the inventory includes sign-out.
    const session = hub.signIn();
    const res = await hub.send(route.method === 'GET' ? 'GET' : 'POST', concrete(route.url), route.method === 'GET' ? undefined : {}, { session });
    const res2 = route.method === 'GET' || route.method === 'POST' ? res : await hub.h.app.inject({
      method: route.method as 'PUT' | 'DELETE' | 'PATCH', url: concrete(route.url), payload: {},
      headers: { origin: 'http://localhost:7410', cookie: session.cookie, 'x-hub-csrf': session.csrf, 'x-hub-key': session.pageKey },
    });
    const body = (() => {
      try {
        return res2.json() as { error?: { code?: string } };
      } catch {
        return {};
      }
    })();
    out.push({ ...route, status: res2.statusCode, code: body.error?.code ?? null });
  }
  return out;
}

describe('while setup is pending, the hub answers only sign-in and setup', () => {
  const routes = routeInventory();

  it('the inventory holds the whole website API, the live socket and the terminal', () => {
    expect(routes.length).toBeGreaterThan(100);
    for (const url of ['/api/overview', '/api/settings', '/api/hosts', '/api/rooms', '/ws', '/ws/terminal', '/api/me', '/api/setup/state']) {
      expect(routes.some((route) => route.url === url), url).toBe(true);
    }
  });

  it('at claim, every other route answers 409 setup_pending to a signed-in browser (a login-link session included)', async () => {
    const hub = await localHub(harness);
    expect((await hub.send('GET', '/api/setup/state')).json()).toMatchObject({ step: 'claim' });
    const answers = await sendEach(hub, routes);
    const gated = answers.filter((answer) => GATED(answer.url));
    expect(gated.length).toBeGreaterThan(90);
    for (const answer of gated) expect({ route: `${answer.method} ${answer.url}`, status: answer.status, code: answer.code }).toMatchObject({ status: 409, code: 'setup_pending' });
    for (const answer of answers.filter((one) => OPEN(one.url))) expect(answer.code, `${answer.method} ${answer.url}`).not.toBe('setup_pending');
  });

  it('says plainly what to do', async () => {
    const hub = await localHub(harness);
    const res = await hub.send('GET', '/api/settings', undefined, { session: hub.signIn() });
    expect(res.json()).toEqual({ error: { code: 'setup_pending', message: 'Finish setting up Luady first: claim this install and choose a PIN.' } });
  });

  it('at the PIN step it still holds; once the PIN is set nothing is gated', async () => {
    const hub = await localHub(harness, { passkey: true });
    expect((await hub.send('GET', '/api/overview', undefined, { session: hub.signIn() })).json()).toMatchObject({ error: { code: 'setup_pending' } });
    const done = await localHub(harness, { passkey: true, pinSet: true });
    const answers = await sendEach(done, routes);
    expect(answers.filter((answer) => answer.code === 'setup_pending')).toEqual([]);
  });

  it('a request without a session still gets 401 first (the gate tells strangers nothing new)', async () => {
    const hub = await localHub(harness);
    expect((await hub.send('GET', '/api/overview')).statusCode).toBe(401);
  });
});
