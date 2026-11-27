import { describe, expect, it, vi } from 'vitest';
import {
  AccountsDTOSchema, ActionDTOSchema, CodexLoginDTOSchema, LoginStartDTOSchema, type AccountsDTO,
} from '@luady/shared';
import { createActionService } from '../../src/actions/service.js';
import type { AccountActions } from '../../src/actions/execute.js';
import { PinInvalidError } from '../../src/core/errors.js';
import { createTicketStore } from '../../src/security/tickets.js';
import { createBus } from '../../src/core/bus.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { call, fakeFleet, fakeSessions, fakeChannel, harnessFactory, ISO, type Harness } from './helpers.js';

const harness = harnessFactory();
const GOOD_PIN = '135790';
const CODE = 'test-auth-code-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#test-state-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
const START = { host: 'cedar' as const, url: 'https://claude.com/cai/oauth/authorize?code=true&state=s1', expiresAt: '2026-10-09T12:30:00.000Z' };
const LIST: AccountsDTO = { accounts: [], connections: [] };

/** A harness whose actions are the real service, so audit rows, tiers and the PIN are real. */
async function realActions(accounts: AccountActions): Promise<Harness> {
  const db = openMemoryDb();
  const bus = createBus();
  const clock = createFakeClock();
  const pin = {
    isSet: () => true, set: async () => undefined,
    verify: vi.fn(async (value: string) => {
      if (value !== GOOD_PIN) throw new PinInvalidError(2);
    }),
  };
  const actions = createActionService({
    db, bus, clock, log: silentLogger(), fleet: fakeFleet(), sessions: fakeSessions(), pin, channel: fakeChannel(),
    tickets: createTicketStore(clock), pauses: { pause: vi.fn(), resume: vi.fn(async () => ({ sent: true })) }, accounts,
    hostSignedOut: () => true,
  });
  return harness({ db, bus, clock, actions });
}

function fakeAccountActions(): AccountActions & { login: ReturnType<typeof vi.fn>; logout: ReturnType<typeof vi.fn> } {
  return { login: vi.fn(async () => 'sign-in started'), logout: vi.fn(async () => 'signed out') };
}


describe('GET /api/accounts', () => {
  it('returns the accounts list', async () => {
    const h = await harness();
    const res = await call(h, 'GET', '/api/accounts', undefined, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(AccountsDTOSchema.parse(res.json())).toEqual(LIST);
  });
});

describe('POST /api/accounts/:host/login', () => {
  it('starts a tier-0 audited sign-in and answers the pending link; the link is not in the audit row', async () => {
    const accounts = fakeAccountActions();
    const h = await realActions(accounts);
    const res = await call(h, 'POST', '/api/accounts/cedar/login', {}, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(LoginStartDTOSchema.parse(res.json())).toEqual(START);
    expect(accounts.login).toHaveBeenCalledWith('cedar', 'web');
    const row = h.deps.db.prepare('SELECT kind, tier, status, params_json, result_text FROM actions').get() as Record<string, unknown>;
    expect(row).toEqual({ kind: 'account.login', tier: 0, status: 'done', params_json: '{"target":"cedar"}', result_text: 'sign-in started' });
    expect(JSON.stringify(row)).not.toContain('state=');
  });

  it('answers 502 with the action error when the sign-in did not start', async () => {
    const accounts = fakeAccountActions();
    accounts.login.mockRejectedValueOnce(new Error('cedar is offline'));
    const h = await realActions(accounts);
    const res = await call(h, 'POST', '/api/accounts/cedar/login', {}, { session: h.login() });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: { code: 'login_failed', message: 'cedar is offline' } });
  });

  it('404 for anything that is not a host', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'POST', '/api/accounts/nope/login', {}, { session })).statusCode).toBe(404);
    expect((await call(h, 'POST', '/api/accounts/nope/code', { code: CODE }, { session })).statusCode).toBe(404);
    expect((await call(h, 'POST', '/api/accounts/codex/code', { code: CODE }, { session })).statusCode).toBe(404);
    expect(h.deps.actions.request).not.toHaveBeenCalled();
  });
});

describe('POST /api/accounts/:host/code', () => {
  it('a 7-character code, a 1,101-character code or an extra field is 400 and never reaches the service', async () => {
    const h = await harness();
    const session = h.login();
    expect((await call(h, 'POST', '/api/accounts/birch/code', { code: 'abcdefg' }, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/accounts/birch/code', { code: 'a'.repeat(1101) }, { session })).statusCode).toBe(400);
    const extra = await call(h, 'POST', '/api/accounts/birch/code', { code: CODE, host: 'cedar' }, { session });
    expect(extra.statusCode).toBe(400);
    expect(extra.body).not.toContain(CODE);
    expect(h.deps.login.submit).not.toHaveBeenCalled();
  });
});

describe('POST /api/accounts/:host/logout', () => {
  it('needs a PIN (400 without, 403 wrong) and with the right one runs an audited account.logout', async () => {
    const accounts = fakeAccountActions();
    const h = await realActions(accounts);
    const session = h.login();
    expect((await call(h, 'POST', '/api/accounts/hq/logout', {}, { session })).statusCode).toBe(400);
    expect((await call(h, 'POST', '/api/accounts/hq/logout', { pin: '000000' }, { session })).statusCode).toBe(403);
    expect(accounts.logout).not.toHaveBeenCalled();
    const res = await call(h, 'POST', '/api/accounts/hq/logout', { pin: GOOD_PIN }, { session });
    expect(res.statusCode).toBe(200);
    // The summary names the manager's own host by the manager's name, never by its raw id.
    expect(ActionDTOSchema.parse(res.json())).toMatchObject({ kind: 'account.logout', tier: 1, status: 'done', result: 'signed out', summary: 'sign Luady out' });
    expect(accounts.logout).toHaveBeenCalledWith('hq');
  });

  it('codex has its own fixed paths: sign-in as data, sign-out with the PIN', async () => {
    const accounts = fakeAccountActions();
    const h = await realActions(accounts);
    const session = h.login();
    const started = await call(h, 'POST', '/api/accounts/codex/login', {}, { session });
    expect(started.statusCode).toBe(200);
    expect(CodexLoginDTOSchema.parse(started.json())).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'AB12-CD34Z', expiresAt: ISO });
    const out = await call(h, 'POST', '/api/accounts/codex/logout', { pin: GOOD_PIN }, { session });
    expect(ActionDTOSchema.parse(out.json())).toMatchObject({ kind: 'account.logout', status: 'done', summary: 'sign ChatGPT (images) out' });
    expect(accounts.logout).toHaveBeenCalledWith('codex');
  });
});

describe('POST /api/accounts/:host/refresh', () => {
  it('reads the host now and answers the list', async () => {
    const h = await harness();
    const res = await call(h, 'POST', '/api/accounts/ash/refresh', {}, { session: h.login() });
    expect(res.statusCode).toBe(200);
    expect(h.deps.login.refresh).toHaveBeenCalledWith('ash');
    expect(AccountsDTOSchema.parse(res.json())).toEqual(LIST);
  });
});

describe('accounts routes need the owner session and CSRF', () => {
  it.for([
    ['GET', '/api/accounts', undefined],
    ['POST', '/api/accounts/cedar/login', {}],
    ['POST', '/api/accounts/cedar/code', { code: CODE }],
    ['POST', '/api/accounts/cedar/logout', { pin: GOOD_PIN }],
    ['POST', '/api/accounts/cedar/refresh', {}],
    ['POST', '/api/accounts/codex/login', {}],
    ['POST', '/api/accounts/codex/logout', { pin: GOOD_PIN }],
  ] as const)('%s %s is 401 without a session', async ([method, url, body]) => {
    const h = await harness();
    expect((await call(h, method, url, body)).statusCode).toBe(401);
    if (method === 'POST') expect((await call(h, method, url, body, { session: h.login(), csrf: null })).statusCode).toBe(403);
    expect(h.deps.login.submit).not.toHaveBeenCalled();
    expect(h.deps.codexLogin.beginData).not.toHaveBeenCalled();
  });
});

