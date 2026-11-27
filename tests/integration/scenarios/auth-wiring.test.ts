import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startTestHub, type TestHub } from '../harness/hub.js';

/**
 * The auth chain as composed by the app. Local mode is what a new install runs: no outer gate,
 * the session cookie with its page key, and the Host check. Cloudflare Access is the opt-in outer gate.
 */

const HOST = { host: 'localhost:7410' };

describe('local mode (a new install): session, page key and Host check', () => {
  let hub: TestHub;

  beforeAll(async () => {
    hub = await startTestHub({ env: inject('luadyIt') });
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it('answers 401 with the error envelope to a request without a session', async () => {
    const res = await hub.app.web.inject({ method: 'GET', url: '/api/overview', headers: HOST });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'auth', message: expect.any(String) } });
  });

  it('refuses a session cookie that comes without its page key', async () => {
    const owner = hub.signIn();
    const res = await hub.app.web.inject({ method: 'GET', url: '/api/overview', headers: { ...HOST, cookie: owner.cookie } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'page_key_required' } });
    const wrong = await hub.app.web.inject({ method: 'GET', url: '/api/overview', headers: { ...owner.headers(), 'x-hub-key': 'x'.repeat(43) } });
    expect(wrong.statusCode).toBe(401);
  });

  it('serves the owner with the cookie and its page key', async () => {
    const res = await hub.app.web.inject({ method: 'GET', url: '/api/overview', headers: hub.signIn().headers() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ servers: expect.any(Array), rooms: expect.any(Array) });
  });

  it('answers 421 to a Host it does not serve, before any app logic', async () => {
    const res = await hub.app.web.inject({ method: 'GET', url: '/api/overview', headers: { ...hub.signIn().headers(), host: 'elsewhere.example:7410' } });
    expect(res.statusCode).toBe(421);
  });
});

describe('Cloudflare Access mode', () => {
  let hub: TestHub;

  beforeAll(async () => {
    hub = await startTestHub({ env: inject('luadyIt'), authMode: 'cloudflare-access' });
  });

  afterAll(async () => {
    await hub?.stop();
  });

  it('rejects a request without a Cloudflare Access JWT with 403 and the error envelope', async () => {
    const res = await hub.app.web.inject({ method: 'GET', url: '/api/me', headers: HOST });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: expect.any(String), message: expect.any(String) } });
  });

  it('rejects a malformed Access JWT with 403 before any app logic', async () => {
    const res = await hub.app.web.inject({ method: 'GET', url: '/api/overview', headers: { ...HOST, 'cf-access-jwt-assertion': 'not-a-jwt' } });
    expect(res.statusCode).toBe(403);
  });
});
