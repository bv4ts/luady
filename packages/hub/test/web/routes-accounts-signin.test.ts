import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, LoginResultDTOSchema, LoginStartDTOSchema, type CtlAuthStatus, type HostId, type Settings } from '@luady/shared';
import { createAccountActions } from '../../src/accounts/actions.js';
import type { AccountActions } from '../../src/actions/execute.js';
import { createActionService } from '../../src/actions/service.js';
import { createClaudeLoginService, type ClaudeLoginService } from '../../src/claude-login/service.js';
import { createBus } from '../../src/core/bus.js';
import type { CtlClient, Fleet } from '../../src/core/contracts.js';
import { PinInvalidError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createTicketStore } from '../../src/security/tickets.js';
import { createFakeClock, createFakeCtl, createFakeOutbound, silentLogger, type FakeOutbound } from '../helpers/fakes.js';
import { call, fakeCodexLogin, fakeFleet, fakeSessions, fakeChannel, harnessFactory, sampleServer, type Harness } from './helpers.js';

const harness = harnessFactory();
const GOOD_PIN = '135790';
const URL = 'https://claude.com/cai/oauth/authorize?code=true&state=s1';
const CODE = 'test-auth-code-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#test-state-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
const TEAM_A: CtlAuthStatus = { logged_in: true, email: 'o@x', expires_at: null, org_id: 'org_team_a', org_name: 'Team A', plan: 'team' };
const TEAM_B: CtlAuthStatus = { logged_in: true, email: 'o@x', expires_at: null, org_id: 'org_team_b', org_name: 'Team B', plan: 'team' };
const OUT: CtlAuthStatus = { logged_in: false, email: null, expires_at: null };

interface Real { h: Harness; login: ClaudeLoginService; kits: Map<HostId, CtlClient & { calls: Array<{ method: string }> }>; outbound: FakeOutbound }

/**
 * The hub as it really runs behind the accounts routes: the real login service, account actions and action service
 * with a real audit table; only the kits, the PIN check and the chat are fakes. `after` is the account a right code
 * signs the host in to.
 */
async function realHub(opts: { requirePin?: boolean; after?: CtlAuthStatus; codex?: 'in' | 'out' | 'unknown' } = {}): Promise<Real> {
  const db = openMemoryDb();
  const bus = createBus();
  const clock = createFakeClock();
  const outbound = createFakeOutbound();
  const auth = new Map<HostId, CtlAuthStatus>([['hq', TEAM_A], ['cedar', TEAM_A], ['birch', TEAM_A], ['ash', OUT]]);
  const kits = new Map<HostId, CtlClient & { calls: Array<{ method: string }> }>();
  const client = (host: HostId) => {
    const found = kits.get(host) ?? createFakeCtl({
      authStatus: async () => auth.get(host) ?? OUT,
      authLogin: async () => ({ url: URL }),
      authCode: async (code) => {
        if (code !== CODE) return { ok: false, message: 'Invalid code', ...(auth.get(host) ?? OUT) };
        auth.set(host, opts.after ?? TEAM_B);
        return { ok: true, message: 'Login successful', ...(opts.after ?? TEAM_B) };
      },
    });
    kits.set(host, found);
    return found;
  };
  const fleet: Fleet = { ...fakeFleet(), client, servers: () => (['cedar', 'birch', 'ash'] as const).map((name) => sampleServer({ name, kitVersion: '2.0.0' })) };
  const settings: Settings = { ...DEFAULT_SETTINGS, require_pin: opts.requirePin ?? true };
  let loginRef: ClaudeLoginService | null = null;
  const pin = {
    isSet: () => true, set: async () => undefined,
    verify: vi.fn(async (value: string) => {
      if (value !== GOOD_PIN) throw new PinInvalidError(2);
    }),
  };
  let accountActions: AccountActions | null = null;
  const ready = (): AccountActions => {
    if (accountActions === null) throw new Error('account actions not ready');
    return accountActions;
  };
  const accounts: AccountActions = { login: (target, channel) => ready().login(target, channel), logout: (target) => ready().logout(target) };
  const actions = createActionService({
    db, bus, clock, log: silentLogger(), fleet, sessions: fakeSessions(), pin, channel: fakeChannel(), tickets: createTicketStore(clock),
    pauses: { pause: vi.fn(), resume: vi.fn(async () => ({ sent: true })) }, accounts, requirePin: () => settings.require_pin,
    hostSignedOut: (host) => loginRef?.statuses().find((s) => s.host === host)?.loggedIn === false,
  });
  const login = createClaudeLoginService({
    db, clock, log: silentLogger(), bus, fleet, outbound, settings: { get: () => settings },
    luady: { rotate: vi.fn(async () => true), release: vi.fn(async () => undefined) }, hosts: () => ['hq', 'cedar', 'birch', 'ash'],
    audit: (entry) => actions.record?.({ kind: 'account.signed_in', actor: 'owner', channel: entry.via, params: { target: entry.host }, summary: entry.summary, result: 'signed in' }),
  });
  loginRef = login;
  const codex = { ...fakeCodexLogin(), begin: async () => 'device code', status: async () => opts.codex ?? 'out', logout: async () => true };
  accountActions = createAccountActions({ login, codex, bus, clock });
  await login.check();
  const h = await harness({ db, bus, clock, actions, login, fleet, codexLogin: codex, settings: { get: () => settings, update: () => settings } });
  return { h, login, kits, outbound };
}

/** The account-move messages (the start-up check also warns that ash is signed out). */
const sends = (real: Real): string[] => real.outbound.sent.map((s) => s.text).filter((text) => text.startsWith('🔐'));
const rows = (h: Harness) => h.deps.db.prepare('SELECT kind, tier, status, summary, params_json, result_text FROM actions ORDER BY seq').all() as Array<Record<string, unknown>>;
const kitCalls = (real: Real, host: HostId): string[] => (real.kits.get(host)?.calls ?? []).map((c) => c.method);

describe('a web session alone cannot move a signed-in host to another account', () => {
  it.for(['hq', 'cedar'] as const)('%s: no sign-in starts without the PIN, so no code can be sent', async (host) => {
    const real = await realHub();
    const session = real.h.login();
    const res = await call(real.h, 'POST', `/api/accounts/${host}/login`, {}, { session });
    expect(res.statusCode).toBe(428);
    expect(res.json()).toMatchObject({ error: { code: 'pin_required' } });
    expect(rows(real.h)).toEqual([]);
    expect(kitCalls(real, host)).not.toContain('authLogin');
    const code = await call(real.h, 'POST', `/api/accounts/${host}/code`, { code: CODE }, { session });
    expect(LoginResultDTOSchema.parse(code.json())).toMatchObject({ ok: false, message: 'No sign-in is waiting. Start a new sign-in.' });
    expect(kitCalls(real, host)).not.toContain('authCode');
    expect((await call(real.h, 'POST', `/api/accounts/${host}/login`, { pin: '000000' }, { session })).statusCode).toBe(403);
    expect(kitCalls(real, host)).not.toContain('authLogin');
  });

  it('with the PIN the sign-in starts as an audited tier-1 action', async () => {
    const real = await realHub();
    const res = await call(real.h, 'POST', '/api/accounts/hq/login', { pin: GOOD_PIN }, { session: real.h.login() });
    expect(res.statusCode).toBe(200);
    expect(LoginStartDTOSchema.parse(res.json()).url).toBe(URL);
    expect(rows(real.h)).toEqual([expect.objectContaining({ kind: 'account.login', tier: 1, status: 'done', params_json: '{"target":"hq"}', result_text: 'sign-in started' })]);
  });

  it('a signed-out host starts without the PIN (tier 0)', async () => {
    const real = await realHub();
    const res = await call(real.h, 'POST', '/api/accounts/ash/login', {}, { session: real.h.login() });
    expect(res.statusCode).toBe(200);
    expect(rows(real.h)).toEqual([expect.objectContaining({ kind: 'account.login', tier: 0, status: 'done' })]);
  });

  it('with PIN confirmations off (they govern only Luady), a signed-in host still needs the right PIN', async () => {
    const real = await realHub({ requirePin: false });
    const session = real.h.login();
    expect((await call(real.h, 'POST', '/api/accounts/cedar/login', {}, { session })).statusCode).toBe(428);
    expect((await call(real.h, 'POST', '/api/accounts/cedar/login', { pin: '000000' }, { session })).statusCode).toBe(403);
    expect(kitCalls(real, 'cedar')).not.toContain('authLogin');
    expect((await call(real.h, 'POST', '/api/accounts/cedar/login', { pin: GOOD_PIN }, { session })).statusCode).toBe(200);
    expect(rows(real.h).at(-1)).toMatchObject({ kind: 'account.login', tier: 1, status: 'done' });
  });
});

describe('a finished sign-in, through the real login service', () => {
  it('is audited with the host and the new account, and the code is in no row, no answer and no message', async () => {
    const real = await realHub();
    const session = real.h.login();
    await call(real.h, 'POST', '/api/accounts/cedar/login', { pin: GOOD_PIN }, { session });
    const wrong = await call(real.h, 'POST', '/api/accounts/cedar/code', { code: 'wrong-code-99' }, { session });
    expect(LoginResultDTOSchema.parse(wrong.json())).toMatchObject({ ok: false, message: 'Invalid code' });
    const res = await call(real.h, 'POST', '/api/accounts/cedar/code', { code: CODE }, { session });
    expect(LoginResultDTOSchema.parse(res.json())).toMatchObject({ host: 'cedar', ok: true, loggedIn: true });
    expect(rows(real.h).map((row) => [row.kind, row.summary, row.result_text])).toEqual([
      ['account.login', 'start a Claude sign-in on cedar', 'sign-in started'],
      ['account.signed_in', 'cedar signed in to Team B (team)', 'signed in'],
    ]);
    const everything = [JSON.stringify(real.h.deps.db.prepare('SELECT * FROM actions').all()), res.body, wrong.body, sends(real).join('\n')].join('\n');
    for (const secret of [CODE, ...CODE.split('#')]) expect(everything).not.toContain(secret);
  });

  it('the owner gets exactly one chat message when the account changes', async () => {
    const real = await realHub();
    const session = real.h.login();
    await call(real.h, 'POST', '/api/accounts/cedar/login', { pin: GOOD_PIN }, { session });
    await call(real.h, 'POST', '/api/accounts/cedar/code', { code: CODE }, { session });
    await real.login.refresh('cedar');
    await real.login.check();
    expect(sends(real)).toEqual(['🔐 cedar is now signed in to Team B (team). If that was not you, sign it out.']);
  });

  it('and none when the same account signs in again', async () => {
    const real = await realHub({ after: TEAM_A });
    const session = real.h.login();
    await call(real.h, 'POST', '/api/accounts/hq/login', { pin: GOOD_PIN }, { session });
    await call(real.h, 'POST', '/api/accounts/hq/code', { code: CODE }, { session });
    expect(sends(real)).toEqual([]);
    // The audit text names the manager's own host by the manager's name, never by its raw id.
    expect(rows(real.h).at(-1)).toMatchObject({ kind: 'account.signed_in', summary: 'Luady signed in to Team A (team)' });
  });
});

describe('the code route trims the code', () => {
  it('a code with spaces and a newline around it reaches the kit trimmed; seven characters inside spaces is 400', async () => {
    const real = await realHub();
    const session = real.h.login();
    await call(real.h, 'POST', '/api/accounts/ash/login', {}, { session });
    expect((await call(real.h, 'POST', '/api/accounts/ash/code', { code: '   abcdefg   ' }, { session })).statusCode).toBe(400);
    const res = await call(real.h, 'POST', '/api/accounts/ash/code', { code: `  ${CODE}\n` }, { session });
    expect(LoginResultDTOSchema.parse(res.json())).toMatchObject({ ok: true });
    expect((real.kits.get('ash')?.calls ?? []).filter((c) => c.method === 'authCode').map((c) => (c as { args: unknown[] }).args[0])).toEqual([CODE]);
  });
});

describe('every sign-in start is audited', () => {
  it('the Codex start from the website leaves an action row without the link or the device code', async () => {
    const real = await realHub();
    const res = await call(real.h, 'POST', '/api/accounts/codex/login', {}, { session: real.h.login() });
    expect(res.statusCode).toBe(200);
    const all = rows(real.h);
    expect(all).toEqual([expect.objectContaining({ kind: 'account.login', tier: 0, status: 'done', params_json: '{"target":"codex"}', result_text: 'sign-in started' })]);
    expect(JSON.stringify(all)).not.toMatch(/auth\.openai\.com|AB12-CD34Z/);
  });
});

describe('changing an account on the website always needs the PIN, whatever require_pin says', () => {
  it.for(['cedar', 'hq'] as const)('signing %s out with a wrong PIN is refused with confirmations off', async (host) => {
    const real = await realHub({ requirePin: false });
    const session = real.h.login();
    expect((await call(real.h, 'POST', `/api/accounts/${host}/logout`, { pin: '000000' }, { session })).statusCode).toBe(403);
    expect(kitCalls(real, host)).not.toContain('authLogout');
    expect((await call(real.h, 'POST', `/api/accounts/${host}/logout`, { pin: GOOD_PIN }, { session })).json()).toMatchObject({ status: 'done' });
  });

  it('a Codex sign-in on a signed-in ChatGPT needs the PIN; a signed-out one does not', async () => {
    const signedIn = await realHub({ requirePin: false, codex: 'in' });
    const session = signedIn.h.login();
    expect((await call(signedIn.h, 'POST', '/api/accounts/codex/login', {}, { session })).statusCode).toBe(428);
    expect((await call(signedIn.h, 'POST', '/api/accounts/codex/login', { pin: '000000' }, { session })).statusCode).toBe(403);
    expect((await call(signedIn.h, 'POST', '/api/accounts/codex/login', { pin: GOOD_PIN }, { session })).statusCode).toBe(200);
    expect(rows(signedIn.h).at(-1)).toMatchObject({ kind: 'account.login', tier: 1, status: 'done', params_json: '{"target":"codex"}' });
    const signedOut = await realHub({ requirePin: false, codex: 'out' });
    expect((await call(signedOut.h, 'POST', '/api/accounts/codex/login', {}, { session: signedOut.h.login() })).statusCode).toBe(200);
  });

  it('signing ChatGPT out with a wrong PIN is refused with confirmations off', async () => {
    const real = await realHub({ requirePin: false, codex: 'in' });
    const session = real.h.login();
    expect((await call(real.h, 'POST', '/api/accounts/codex/logout', { pin: '000000' }, { session })).statusCode).toBe(403);
    expect((await call(real.h, 'POST', '/api/accounts/codex/logout', { pin: GOOD_PIN }, { session })).json()).toMatchObject({ status: 'done' });
  });
});
