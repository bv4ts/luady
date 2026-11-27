import { describe, expect, it } from 'vitest';
import { PAGE_KEY_HEADER } from '@luady/shared';
import { RefusedError } from '../../src/core/errors.js';
import { SETUP_CODE_TTLS } from '../../src/security/setup-codes.js';
import { issueLoginLink } from '../../src/setup/index.js';
import { FORWARDING_HEADERS } from '../../src/web/auth/login-link.js';
import { createCaptureLogger } from '../security/capture-logger.js';
import { harnessFactory } from '../web/helpers.js';
import { LOCAL_ORIGIN, OWNER_PIN, localHub, sessionCookie, type LocalHub } from './local-hub.js';

const harness = harnessFactory();

/** A link as `luady login` writes it: straight to the hub's database, from another process. */
function cliToken(hub: LocalHub): string {
  const link = issueLoginLink(hub.db, hub.config, hub.clock);
  expect(link.url.startsWith(`${LOCAL_ORIGIN}/setup/login#`)).toBe(true);
  return link.url.slice(link.url.indexOf('#') + 1);
}

function failedCount(hub: LocalHub): unknown {
  return hub.db.prepare('SELECT failed_count AS n FROM pin_state WHERE id = 1').get();
}

describe('the login link', () => {
  it('a token the CLI wrote to the database signs this computer in while the hub runs, and only its sha256 is stored', async () => {
    const hub = await localHub(harness);
    const token = cliToken(hub);
    const stored = hub.db.prepare("SELECT code_sha256 FROM setup_codes WHERE purpose = 'owner_login'").all() as Array<{ code_sha256: string }>;
    expect(JSON.stringify(stored)).not.toContain(token);
    const res = await hub.send('POST', '/api/setup/login', { token });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json() as object)).toEqual(['pageKey']);
  });

  it('success sets a rotated hub_sid, returns the page key, and the session works with that key', async () => {
    const hub = await localHub(harness);
    const before = hub.signIn();
    const res = await hub.send('POST', '/api/setup/login', { token: cliToken(hub) }, { session: before });
    expect(res.statusCode).toBe(200);
    const { pageKey } = res.json() as { pageKey: string };
    const cookie = sessionCookie(res);
    expect(cookie).not.toBe(before.cookie);
    expect(hub.store.peek(before.sid)).toBeNull();
    const me = await hub.send('GET', '/api/me', undefined, { headers: { cookie, [PAGE_KEY_HEADER]: pageKey } });
    expect(me.statusCode).toBe(200);
    expect(me.body).not.toContain(pageKey);
    expect((await hub.send('GET', '/api/me', undefined, { headers: { cookie } })).statusCode).toBe(401);
  });

  it('a peer that is not loopback gets 403, and the token stays unused', async () => {
    const hub = await localHub(harness);
    const token = cliToken(hub);
    const res = await hub.send('POST', '/api/setup/login', { token }, { remoteAddress: '192.0.2.10' });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'forbidden' } });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect((await hub.send('POST', '/api/setup/login', { token })).statusCode).toBe(200);
  });

  // The fixed list, every x-forwarded-* header, `via`, and the common client-address headers.
  const PROXY_HEADERS = [
    ...FORWARDING_HEADERS, 'via', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-prefix', 'x-forwarded-anything',
    'x-client-ip', 'x-real-ip', 'true-client-ip', 'fly-client-ip', 'cf-connecting-ip', 'forwarded',
  ];

  it.for(PROXY_HEADERS.map((name) => ({ name })))('any forwarding header gets 403: $name', async ({ name }) => {
    const hub = await localHub(harness);
    const res = await hub.send('POST', '/api/setup/login', { token: cliToken(hub) }, { headers: { [name]: '127.0.0.1' } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'forbidden', message: expect.stringMatching(/not through a proxy/) } });
  });

  it('a remote install is refused: the CLI issues nothing and the route answers 403', async () => {
    const hub = await localHub(harness, { config: { bindHost: '0.0.0.0' } });
    expect(() => issueLoginLink(hub.db, hub.config, hub.clock)).toThrow(RefusedError);
    const token = hub.setupCodes.issue('owner_login');
    const res = await hub.send('POST', '/api/setup/login', { token });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { message: expect.stringMatching(/Sign in with a passkey/) } });
  });

  it('is single use', async () => {
    const hub = await localHub(harness);
    const token = cliToken(hub);
    expect((await hub.send('POST', '/api/setup/login', { token })).statusCode).toBe(200);
    const again = await hub.send('POST', '/api/setup/login', { token });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({ error: { message: 'This login link was already used' } });
  });

  it('lives 5 minutes', async () => {
    const hub = await localHub(harness);
    const token = cliToken(hub);
    hub.clock.advance(SETUP_CODE_TTLS.owner_login);
    const late = await hub.send('POST', '/api/setup/login', { token });
    expect(late.statusCode).toBe(401);
    expect(late.json()).toMatchObject({ error: { message: 'This login link expired' } });
  });

  it('a setup code is never a login token', async () => {
    const hub = await localHub(harness);
    const code = hub.setupCodes.issue('owner_setup');
    expect((await hub.send('POST', '/api/setup/login', { token: `${code}${code}` })).statusCode).toBe(401);
    expect((await hub.send('POST', '/api/setup/login', { token: code })).statusCode).toBe(400);
  });

  it('with a PIN set, a missing PIN gets 428 and counts nothing; a wrong one gets 403 and counts; the right one works', async () => {
    const hub = await localHub(harness, { passkey: true, pinSet: true });
    const token = cliToken(hub);
    const missing = await hub.send('POST', '/api/setup/login', { token });
    expect(missing.statusCode).toBe(428);
    expect(missing.json()).toMatchObject({ error: { code: 'pin_required' } });
    expect(failedCount(hub)).toEqual({ n: 0 });
    const wrong = await hub.send('POST', '/api/setup/login', { token, pin: '000000' });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ error: { code: 'pin_invalid', remaining: 2 } });
    expect(failedCount(hub)).toEqual({ n: 1 });
    const right = await hub.send('POST', '/api/setup/login', { token, pin: OWNER_PIN });
    expect(right.statusCode).toBe(200);
    expect(failedCount(hub)).toEqual({ n: 0 });
  });

  it('a locked PIN keeps the door shut: 423, even with the right PIN', async () => {
    const hub = await localHub(harness, { passkey: true, pinSet: true });
    const token = cliToken(hub);
    for (let i = 0; i < 3; i += 1) expect((await hub.send('POST', '/api/setup/login', { token, pin: '000000' })).statusCode).toBe(403);
    expect((await hub.send('POST', '/api/setup/login', { token, pin: OWNER_PIN })).statusCode).toBe(423);
  });

  it('without a valid token no PIN is ever tried: the owner cannot be locked out by strangers', async () => {
    const hub = await localHub(harness, { passkey: true, pinSet: true });
    const res = await hub.send('POST', '/api/setup/login', { token: 'x'.repeat(43), pin: '000000' });
    expect(res.statusCode).toBe(401);
    expect(failedCount(hub)).toEqual({ n: 0 });
  });

  it('a request from another origin is refused by the Origin rule', async () => {
    const hub = await localHub(harness);
    const res = await hub.send('POST', '/api/setup/login', { token: cliToken(hub) }, { headers: { origin: 'http://localhost:9999' } });
    expect(res.statusCode).toBe(403);
  });

  it('never logs the token, the page key or the PIN', async () => {
    const capture = createCaptureLogger();
    const hub = await localHub(harness, { passkey: true, pinSet: true, log: capture.log });
    const token = cliToken(hub);
    await hub.send('POST', '/api/setup/login', { token, pin: '000000' });
    await hub.send('POST', '/api/setup/login', { token }, { remoteAddress: '192.0.2.10' });
    const ok = await hub.send('POST', '/api/setup/login', { token, pin: OWNER_PIN });
    const { pageKey } = ok.json() as { pageKey: string };
    const text = capture.lines.join('\n');
    expect(text).toMatch(/signed in/);
    for (const secret of [token, pageKey, OWNER_PIN, '000000']) expect(text).not.toContain(secret);
  });
});
