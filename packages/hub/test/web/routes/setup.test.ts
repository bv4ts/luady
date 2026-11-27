import { describe, expect, it } from 'vitest';
import { PAGE_KEY_HEADER, SetupStateDTOSchema, type SetupStateDTO } from '@luady/shared';
import { claimBanner, issueLoginLink } from '../../../src/setup/index.js';
import { localHub, OWNER_PIN, type LocalHub, type SignedIn } from '../../setup/local-hub.js';
import { harnessFactory } from '../helpers.js';

const harness = harnessFactory();

/** Every secret the CLI side printed in a test (the hub's own issues are recorded by the spy in local-hub.ts). */
const printed: string[] = [];

async function linkSession(hub: LocalHub, pin?: string): Promise<SignedIn> {
  const link = issueLoginLink(hub.db, hub.config, hub.clock);
  const token = link.url.slice(link.url.indexOf('#') + 1);
  printed.push(token, ...(link.setupCode === null ? [] : [link.setupCode]));
  const res = await hub.send('POST', '/api/setup/login', pin === undefined ? { token } : { token, pin });
  expect(res.statusCode).toBe(200);
  const header = res.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header[0] : String(header)).split(';', 1)[0] ?? '';
  const { pageKey } = res.json() as { pageKey: string };
  const me = await hub.send('GET', '/api/me', undefined, { headers: { cookie, [PAGE_KEY_HEADER]: pageKey } });
  return { cookie, pageKey, csrf: (me.json() as { csrf: string }).csrf, sid: '' };
}

const state = (res: { json(): unknown }): SetupStateDTO => SetupStateDTOSchema.parse(res.json());

describe('GET /api/setup/state', () => {
  it('needs no session or page key and answers exactly the five fields', async () => {
    const hub = await localHub(harness);
    const res = await hub.send('GET', '/api/setup/state');
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json() as object).sort()).toEqual(['authMode', 'claimed', 'remote', 'skipped', 'step']);
    expect(res.json()).toEqual({ step: 'claim', claimed: false, authMode: 'local', remote: false, skipped: [] });
  });

  it('reveals no names, hosts, paths or versions, even on a configured install', async () => {
    const hub = await localHub(harness, { passkey: true, pinSet: true, config: { ownerLabel: 'Robin' } });
    const body = (await hub.send('GET', '/api/setup/state')).body;
    for (const word of ['Robin', 'localhost', hub.config.dataDir, '7410', 'owner']) expect(body).not.toContain(word);
  });

  it('40 state calls in a minute all pass, and a sign-in right after still works', async () => {
    const hub = await localHub(harness);
    for (let i = 0; i < 40; i += 1) expect((await hub.send('GET', '/api/setup/state')).statusCode, `call ${i}`).toBe(200);
    await linkSession(hub);
  });

  it('no response ever carries a setup code or a login token (a spy on issue)', async () => {
    const hub = await localHub(harness);
    const banner = claimBanner(hub.db, hub.config, { clock: hub.clock });
    printed.push((banner.lines.find((line) => line.startsWith('Setup code: ')) ?? '').slice('Setup code: '.length).replace(/-/g, ''));
    const bodies: string[] = [];
    bodies.push((await hub.send('GET', '/api/setup/state')).body);
    const session = await linkSession(hub);
    // Issued after the link (a new code voids the earlier ones).
    const code = hub.setupCodes.issue('owner_setup');
    bodies.push((await hub.send('GET', '/api/setup/state')).body);
    bodies.push((await hub.send('POST', '/api/setup/step', { step: 'passkey', action: 'skip' }, { session })).body);
    expect((await hub.send('POST', '/api/auth/pin', { newPin: OWNER_PIN, setupCode: code }, { session })).statusCode).toBe(200);
    for (const [step, action] of [['rooms', 'done'], ['connect', 'skip'], ['extras', 'done']] as const) {
      bodies.push((await hub.send('POST', '/api/setup/step', { step, action }, { session })).body);
    }
    bodies.push((await hub.send('POST', '/api/setup/finish', {}, { session })).body);
    bodies.push((await hub.send('GET', '/api/setup/state')).body);
    expect(hub.setupCodes.issue).toHaveBeenCalled();
    const secrets = [...hub.issued, ...printed];
    expect(secrets.length).toBeGreaterThanOrEqual(4);
    for (const secret of secrets) expect(secret).toMatch(/^[A-Za-z0-9_-]{12,}$/);
    for (const body of bodies) for (const secret of secrets) expect(body).not.toContain(secret);
  });
});

describe('POST /api/setup/step and /finish (session and page key)', () => {
  it('need a session, its page key and the CSRF token', async () => {
    const hub = await localHub(harness, { passkey: true, pinSet: true });
    const session = hub.signIn();
    const body = { step: 'rooms', action: 'done' };
    expect((await hub.send('POST', '/api/setup/step', body)).statusCode).toBe(401);
    expect((await hub.send('POST', '/api/setup/step', body, { session, noKey: true })).statusCode).toBe(401);
    expect((await hub.send('POST', '/api/setup/finish', {}, { session, noKey: true })).statusCode).toBe(401);
    expect((await hub.send('POST', '/api/setup/step', body, { session, headers: { 'x-hub-csrf': 'wrong' } })).statusCode).toBe(403);
    expect(state(await hub.send('POST', '/api/setup/step', body, { session })).step).toBe('connect');
  });

  it('walks rooms → connect → extras → done, telling the open pages each time', async () => {
    const hub = await localHub(harness, { passkey: true, pinSet: true });
    const session = hub.signIn();
    expect(state(await hub.send('POST', '/api/setup/step', { step: 'rooms', action: 'skip' }, { session }))).toMatchObject({ step: 'connect', skipped: ['rooms'] });
    expect(state(await hub.send('POST', '/api/setup/step', { step: 'connect', action: 'done' }, { session })).step).toBe('extras');
    expect(state(await hub.send('POST', '/api/setup/step', { step: 'extras', action: 'done' }, { session })).step).toBe('extras');
    expect(state(await hub.send('POST', '/api/setup/finish', {}, { session }))).toMatchObject({ step: 'done', claimed: true });
    expect(hub.events.map((event) => event.step)).toEqual(['connect', 'extras', 'done']);
  });

  it('answers 409 for a step ahead of the current one, and 400 for an unknown step or extra field', async () => {
    const hub = await localHub(harness, { passkey: true, pinSet: true });
    const session = hub.signIn();
    expect((await hub.send('POST', '/api/setup/step', { step: 'extras', action: 'done' }, { session })).statusCode).toBe(409);
    expect((await hub.send('POST', '/api/setup/step', { step: 'pin', action: 'done' }, { session })).statusCode).toBe(400);
    expect((await hub.send('POST', '/api/setup/step', { step: 'rooms', action: 'done', extra: 1 }, { session })).statusCode).toBe(400);
    expect((await hub.send('POST', '/api/setup/finish', { now: true }, { session })).statusCode).toBe(400);
  });
});

describe('the passkey skip', () => {
  it('a login-link session may skip; the PIN is next and still needs the setup code', async () => {
    const hub = await localHub(harness);
    const session = await linkSession(hub);
    const skipped = await hub.send('POST', '/api/setup/step', { step: 'passkey', action: 'skip' }, { session });
    expect(state(skipped)).toEqual({ step: 'pin', claimed: false, authMode: 'local', remote: false, skipped: ['passkey'] });
    expect((await hub.send('POST', '/api/auth/pin', { newPin: OWNER_PIN }, { session })).statusCode).toBe(401);
    const code = hub.setupCodes.issue('owner_setup');
    expect((await hub.send('POST', '/api/auth/pin', { newPin: OWNER_PIN, setupCode: code }, { session })).statusCode).toBe(200);
    expect(state(await hub.send('GET', '/api/setup/state'))).toMatchObject({ step: 'rooms', claimed: true });
  });

  it('any other session gets 403', async () => {
    const hub = await localHub(harness);
    const res = await hub.send('POST', '/api/setup/step', { step: 'passkey', action: 'skip' }, { session: hub.signIn() });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'forbidden', message: expect.stringMatching(/npm run luady -- login/) } });
    expect(state(await hub.send('GET', '/api/setup/state')).step).toBe('claim');
  });

  it('a link session behind a forwarding header, or from another machine, gets 403', async () => {
    const hub = await localHub(harness);
    const session = await linkSession(hub);
    const body = { step: 'passkey', action: 'skip' };
    expect((await hub.send('POST', '/api/setup/step', body, { session, headers: { 'x-forwarded-for': '198.51.100.4' } })).statusCode).toBe(403);
    expect((await hub.send('POST', '/api/setup/step', body, { session, remoteAddress: '192.0.2.10' })).statusCode).toBe(403);
    expect(state(await hub.send('GET', '/api/setup/state')).skipped).toEqual([]);
  });

  it('a remote install never allows it', async () => {
    const hub = await localHub(harness, { config: { bindHost: '0.0.0.0' } });
    const session = hub.signIn();
    hub.setup.keepLinkSession(session.pageKey);
    const res = await hub.send('POST', '/api/setup/step', { step: 'passkey', action: 'skip' }, { session });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { message: expect.stringMatching(/passkey is required/) } });
  });

  it('a link session ends when its session ends: after a new sign-in the old key no longer counts', async () => {
    const hub = await localHub(harness);
    const first = await linkSession(hub);
    expect(hub.setup.isLinkSession(first.pageKey)).toBe(true);
    hub.clock.advance(12 * 60 * 60 * 1000);
    expect(hub.setup.isLinkSession(first.pageKey)).toBe(false);
  });
});
