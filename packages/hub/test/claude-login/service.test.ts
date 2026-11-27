import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type CtlAuthStatus, type HostId, type ServerDTO } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { CtlClient, HubEvents } from '../../src/core/contracts.js';
import { CtlError, KitTooOldError, RefusedError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import {
  CODE_ATTEMPTS_MAX, LOGIN_WAIT_MS, SERVER_CHECK_MS, createClaudeLoginService, scrubCode,
} from '../../src/claude-login/service.js';
import { whenText } from '../../src/claude-login/text.js';
import { createCaptureLogger } from '../security/capture-logger.js';
import { createFakeClock, createFakeCtl, createFakeOutbound } from '../helpers/fakes.js';

// 2026-11-07 10:00 AM owner time
const T0 = '2026-11-07T06:00:00.000Z';
const URL = 'https://claude.com/cai/oauth/authorize?code=true&state=s1';
const CODE = 'test-auth-code-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#test-state-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
const WRONG = 'wrongWrongWrongWrongWrong#stateStateStateStateState';
const HOSTS: readonly HostId[] = ['hq', 'cedar', 'birch', 'ash', 'local'];
const SIGNED_OUT: CtlAuthStatus = { logged_in: false, email: null, expires_at: null };

function server(name: ServerDTO['name'], status: ServerDTO['status'] = 'online'): ServerDTO {
  return { name, host: name, status, lastSeenAt: null, claudeVersion: null, kitVersion: '2.0.0', sysinfo: null };
}

/** Every captured logger of every test: checked after each test for the code and the link. */
const captured: Array<readonly string[]> = [];

function setup(statuses: Partial<Record<HostId, CtlAuthStatus>> = {}, over: Partial<CtlClient> = {}, db = openMemoryDb()) {
  const clock = createFakeClock(T0);
  const outbound = createFakeOutbound();
  const capture = createCaptureLogger();
  captured.push(capture.lines);
  const bus = createBus();
  const changes: Array<HubEvents['accounts.changed']> = [];
  bus.on('accounts.changed', (event) => changes.push(event));
  const auth = new Map<HostId, CtlAuthStatus>(Object.entries(statuses) as Array<[HostId, CtlAuthStatus]>);
  const clients = new Map<HostId, ReturnType<typeof createFakeCtl>>();
  const client = (host: HostId) => {
    const existing = clients.get(host);
    if (existing) return existing;
    const created = createFakeCtl({
      authStatus: async () => auth.get(host) ?? { logged_in: true, email: 'o@x', expires_at: '2026-12-30T00:00:00.000Z', org_id: `org_${host}`, plan: 'max' },
      authLogin: async () => ({ url: URL }),
      authCode: async (code) => (code === CODE
        ? { ok: true, message: 'Login successful', logged_in: true, email: 'o@x', expires_at: '2026-11-11T00:00:00.000Z', org_id: 'org_x' }
        : { ok: false, message: `OAuth error: Invalid code ${code}`, logged_in: false, email: null, expires_at: null }),
      authLogout: async () => {
        auth.set(host, SIGNED_OUT);
        return { ok: true, message: 'Signed out', ...SIGNED_OUT };
      },
      ...over,
    });
    clients.set(host, created);
    return created;
  };
  /** What reached the owner and the brain, in order. */
  const order: string[] = [];
  const rotate = vi.fn(async (_force?: boolean) => {
    order.push('rotate');
    return true;
  });
  const accountChanges: HostId[] = [];
  const audit = vi.fn((entry: { host: HostId; summary: string }) => {
    order.push(`audit:${entry.summary}`);
  });
  const sendOutbound = outbound.send.bind(outbound);
  outbound.send = async (text, link, quotedId) => {
    order.push(`chat:${text}`);
    return sendOutbound(text, link, quotedId);
  };
  const release = vi.fn(async () => undefined);
  const servers = [server('cedar'), server('birch'), server('ash'), server('local', 'offline')];
  const login = createClaudeLoginService({
    db, clock, log: capture.log, bus, fleet: { client, servers: () => servers }, outbound, settings: { get: () => DEFAULT_SETTINGS },
    luady: { rotate, release }, hosts: () => HOSTS, audit, onAccountChange: (host) => accountChanges.push(host),
  });
  return {
    db, login, clock, outbound, auth, client, rotate, release, changes, audit, order, accountChanges, lines: capture.lines,
    texts: () => outbound.sent.map((s) => s.text),
  };
}

/** No log line may hold the code (or either half of it) or the link's query string. */
function expectClean(lines: readonly string[]): void {
  for (const line of lines) {
    for (const secret of [CODE, ...CODE.split('#'), WRONG, ...WRONG.split('#'), 'state=', URL]) expect(line).not.toContain(secret);
  }
}

afterEach(() => {
  for (const lines of captured.splice(0)) expectClean(lines);
});

describe('claude login service: one pending sign-in per host', () => {
  it('two sign-ins wait at once; the newest is birch; a code for cedar signs cedar in and leaves birch waiting', async () => {
    const t = setup();
    const cedar = await t.login.begin('cedar');
    expect(cedar).toEqual({ host: 'cedar', url: URL, expiresAt: new Date(Date.parse(T0) + LOGIN_WAIT_MS).toISOString() });
    t.clock.advance(1_000);
    await t.login.begin('birch');
    expect(t.login.latestPending()).toBe('birch');
    const result = await t.login.submit('cedar', CODE);
    expect(result).toEqual({ host: 'cedar', ok: true, message: 'Login successful', loggedIn: true, expiresAt: '2026-11-11T00:00:00.000Z', brainRestarted: false });
    expect(t.client('cedar').calls.find((c) => c.method === 'authCode')?.args).toEqual([CODE]);
    expect(t.login.pending('cedar')).toBeNull();
    expect(t.login.pending('birch')).toMatchObject({ host: 'birch', url: URL });
    expect(t.login.latestPending()).toBe('birch');
    expectClean(t.lines);
  });

  it('a wrong code for one host leaves the other waiting', async () => {
    const t = setup();
    await t.login.begin('cedar');
    await t.login.begin('birch');
    const result = await t.login.submit('birch', WRONG);
    expect(result).toMatchObject({ host: 'birch', ok: false, loggedIn: false });
    expect(result.message).toBe('OAuth error: Invalid code [code]');
    expect(t.login.pending('cedar')).not.toBeNull();
    expect(t.login.pending('birch')).not.toBeNull();
    expectClean(t.lines);
  });

  it('a second begin on the same host replaces the first', async () => {
    const t = setup();
    await t.login.begin('cedar');
    t.clock.advance(20 * 60_000);
    await t.login.begin('cedar');
    t.clock.advance(20 * 60_000);
    expect(t.login.pending('cedar')).not.toBeNull();
    expect(t.client('cedar').calls.filter((c) => c.method === 'authLogin')).toHaveLength(2);
  });

  it('a pending sign-in older than 30 minutes is gone', async () => {
    const t = setup();
    await t.login.begin('cedar');
    t.clock.advance(LOGIN_WAIT_MS - 1);
    expect(t.login.pending('cedar')).not.toBeNull();
    t.clock.advance(1);
    expect(t.login.pending('cedar')).toBeNull();
    expect(t.login.latestPending()).toBeNull();
    expect(await t.login.submit('cedar', CODE)).toMatchObject({ ok: false, message: 'No sign-in is waiting. Start a new sign-in.' });
    expect(t.client('cedar').calls.map((c) => c.method)).toEqual(['authLogin']);
  });

  it('five wrong codes keep the sign-in, the sixth ends it with "Too many tries"', async () => {
    const t = setup();
    await t.login.begin('ash');
    for (let i = 0; i < CODE_ATTEMPTS_MAX; i += 1) expect((await t.login.submit('ash', WRONG)).ok).toBe(false);
    expect(t.login.pending('ash')).not.toBeNull();
    expect(await t.login.submit('ash', WRONG)).toMatchObject({ ok: false, message: 'Too many tries. Start a new sign-in.' });
    expect(t.login.pending('ash')).toBeNull();
    expect(await t.login.submit('ash', CODE)).toMatchObject({ ok: false, message: 'No sign-in is waiting. Start a new sign-in.' });
    expectClean(t.lines);
  });

  it('a 1,100-character code with # reaches the kit; pasted again after success: "No sign-in is waiting"', async () => {
    const long = `${'a'.repeat(600)}#${'b'.repeat(499)}`;
    expect(long).toHaveLength(1100);
    const t = setup({}, { authCode: async () => ({ ok: true, message: 'Login successful', logged_in: true, email: null, expires_at: null }) });
    await t.login.begin('cedar');
    expect((await t.login.submit('cedar', long)).ok).toBe(true);
    expect(t.client('cedar').calls.find((c) => c.method === 'authCode')?.args).toEqual([long]);
    expect(await t.login.submit('cedar', long)).toMatchObject({ ok: false, message: 'No sign-in is waiting. Start a new sign-in.' });
    expect(t.client('cedar').calls.filter((c) => c.method === 'authCode')).toHaveLength(1);
  });

  it('a code too long or too short never reaches the kit and counts as a wrong try', async () => {
    const t = setup();
    await t.login.begin('cedar');
    expect((await t.login.submit('cedar', 'x'.repeat(1101))).message).toBe("That doesn't look like the sign-in code. Copy the whole code and send it again.");
    expect((await t.login.submit('cedar', 'short')).ok).toBe(false);
    expect(t.client('cedar').calls.filter((c) => c.method === 'authCode')).toEqual([]);
  });

  it('a usage error asks for the whole code; not_found ends the sign-in; other failures keep it', async () => {
    const usage = setup({}, { authCode: async () => { throw new CtlError('usage', 'bad code format', 2); } });
    await usage.login.begin('birch');
    expect((await usage.login.submit('birch', CODE)).message).toBe("That doesn't look like the sign-in code. Copy the whole code and send it again.");
    expect(usage.login.pending('birch')).not.toBeNull();

    const ended = setup({}, { authCode: async () => { throw new CtlError('not_found', 'no sign-in is waiting', 4); } });
    await ended.login.begin('birch');
    expect(await ended.login.submit('birch', CODE)).toMatchObject({ ok: false, message: 'no sign-in is waiting' });
    expect(ended.login.pending('birch')).toBeNull();

    const echo = setup({}, { authCode: async (code) => { throw new CtlError('failed', `luady-ctl auth-code exited with 1: bad ${code}`, 1); } });
    await echo.login.begin('birch');
    const result = await echo.login.submit('birch', CODE);
    expect(result.message).toBe('luady-ctl auth-code exited with 1: bad [code]');
    expect(echo.login.pending('birch')).not.toBeNull();
    expectClean(echo.lines);
  });

  it.for([
    'http://claude.com/oauth/authorize?state=s1',
    ['https://', 'claude.ai:login', '@evil.example/oauth/authorize'].join(''),
    'https://claude.ai.evil.example/oauth/authorize',
    'https://evil.example/claude.ai',
    'https://user@claude.ai/oauth/authorize',
    'javascript:alert(1)',
  ])('refuses %s with a clear error and keeps nothing pending', async (url) => {
    const t = setup({}, { authLogin: async () => ({ url }) });
    const err = await t.login.begin('cedar').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefusedError);
    expect((err as Error).message).toBe('The server returned an unexpected sign-in link');
    expect(t.login.pending('cedar')).toBeNull();
  });

  it.for([
    'https://claude.ai/oauth/authorize?code=true&state=s1',
    'https://claude.com/cai/oauth/authorize?code=true&state=s1',
    'https://console.anthropic.com/oauth/authorize?state=s1',
    'https://CLAUDE.AI:443/oauth/authorize',
  ])('accepts a link that points at the provider: %s', async (url) => {
    const t = setup({}, { authLogin: async () => ({ url }) });
    expect((await t.login.begin('cedar')).url).toBe(url);
  });

  it('a link the fleet client already refused as not https gets the same answer', async () => {
    const parsed = setup({}, { authLogin: async () => { throw new CtlError('failed', 'luady-ctl auth-login: unexpected output (url Invalid URL)', 0); } });
    await expect(parsed.login.begin('cedar')).rejects.toThrow('The server returned an unexpected sign-in link');
  });
});

describe('claude login service: sign-out and the brain', () => {
  it('logout(hq) signs out and holds the brain; a later sign-in restarts it (messages: brain-hold.test.ts)', async () => {
    const t = setup();
    const out = await t.login.logout('hq');
    expect(t.client('hq').calls.map((c) => c.method)).toEqual(['authLogout']);
    expect(out).toEqual({ host: 'hq', ok: true, message: 'Signed out', loggedIn: false, expiresAt: null, brainRestarted: false });
    expect(t.login.brainSignedOut()).toBe(true);
    await t.login.check();
    expect(t.texts()).toEqual([]);
    await t.login.begin('hq');
    const back = await t.login.submit('hq', CODE);
    expect(back).toMatchObject({ ok: true, brainRestarted: true });
    expect(t.rotate).toHaveBeenCalledWith(true);
    expect(t.login.brainSignedOut()).toBe(false);
  });

  it('a renewal while Luady is signed in only restarts an idle brain', async () => {
    const t = setup();
    await t.login.begin('hq');
    await t.login.submit('hq', CODE);
    expect(t.rotate).toHaveBeenCalledWith(false);
  });

  it('logout clears the host sign-in that waited, and refreshes its status', async () => {
    const t = setup();
    await t.login.begin('cedar');
    await t.login.logout('cedar');
    expect(t.login.pending('cedar')).toBeNull();
    expect(t.login.statuses().find((s) => s.host === 'cedar')).toMatchObject({ loggedIn: false, checkedAt: T0 });
  });

  it('logout on a kit 1 server says the kit is too old', async () => {
    const t = setup({}, { authLogout: async () => { throw new CtlError('usage', 'unknown verb', 2); } });
    await expect(t.login.logout('ash')).rejects.toBeInstanceOf(KitTooOldError);
  });
});

describe('claude login service: statuses and accounts.changed', () => {
  it('lists every configured host, with nulls before the first check and org and plan after it', async () => {
    const t = setup();
    expect(t.login.statuses().map((s) => s.host)).toEqual(HOSTS);
    expect(t.login.statuses()[1]).toEqual({ host: 'cedar', loggedIn: null, email: null, orgId: null, orgName: null, plan: null, expiresAt: null, checkedAt: null });
    await t.login.check();
    expect(t.login.statuses().find((s) => s.host === 'cedar')).toMatchObject({ loggedIn: true, orgId: 'org_cedar', plan: 'max', checkedAt: T0 });
    expect(t.login.statuses().find((s) => s.host === 'local')?.checkedAt).toBeNull();
  });

  it('a check that finds the same state emits nothing, a changed one exactly one', async () => {
    const t = setup();
    await t.login.check();
    expect(t.changes).toHaveLength(1);
    t.clock.advance(SERVER_CHECK_MS);
    await t.login.check();
    expect(t.changes).toHaveLength(1);
    t.auth.set('birch', { logged_in: true, email: 'o@x', expires_at: '2027-01-30T00:00:00.000Z', org_id: 'org_birch', plan: 'max' });
    t.auth.set('ash', SIGNED_OUT);
    t.clock.advance(SERVER_CHECK_MS);
    await t.login.check();
    expect(t.changes).toHaveLength(2);
  });

  it('emits after every begin, submit and logout', async () => {
    const t = setup();
    await t.login.begin('cedar');
    await t.login.submit('cedar', WRONG);
    await t.login.logout('cedar');
    expect(t.changes).toHaveLength(3);
  });

  it('refresh reads one host now', async () => {
    const t = setup({ ash: { logged_in: true, email: 'A@B.c', expires_at: null, org_id: 'org_ash' } });
    expect(await t.login.refresh('ash')).toMatchObject({ host: 'ash', loggedIn: true, email: 'A@B.c', orgId: 'org_ash' });
    expect(t.changes).toHaveLength(1);
    await t.login.refresh('ash');
    expect(t.changes).toHaveLength(1);
  });

  it('scrubCode removes the code and each half of it', () => {
    expect(scrubCode(`x ${CODE} y ${CODE.split('#')[1]}`, CODE)).toBe('x [code] y [code]');
  });
});

describe('claude login service: alerts', () => {
  it('warns once per host when signed out or running out within 48 hours', async () => {
    const t = setup({
      ash: { logged_in: true, email: 'o@x', expires_at: '2026-11-08T06:01:23.415Z' },
      cedar: SIGNED_OUT,
    });
    await t.login.check();
    expect(t.texts()).toEqual([
      "🔴 *cedar is signed out of Claude*, so its sessions can't work. Send /login cedar to sign in.",
      "🔴 *ash's Claude login runs out tomorrow 10:01 AM.* Send /login ash to renew it now.",
    ]);
    t.clock.advance(SERVER_CHECK_MS);
    await t.login.check();
    expect(t.texts()).toHaveLength(2);
    expect(t.client('local').calls).toEqual([]);
  });

  it('checks servers hourly but Luady every time', async () => {
    const t = setup();
    await t.login.check();
    await t.login.check();
    expect(t.client('hq').calls.filter((c) => c.method === 'authStatus')).toHaveLength(2);
    expect(t.client('cedar').calls.filter((c) => c.method === 'authStatus')).toHaveLength(1);
  });

  it('a renewed login warns again only for its new expiry', async () => {
    const t = setup({ birch: { logged_in: true, email: 'o@x', expires_at: '2026-11-08T12:00:00.000Z' } });
    await t.login.check();
    t.auth.set('birch', { logged_in: true, email: 'o@x', expires_at: '2026-12-08T12:00:00.000Z' });
    t.clock.advance(SERVER_CHECK_MS);
    await t.login.check();
    t.auth.set('birch', { logged_in: true, email: 'o@x', expires_at: '2026-11-08T12:00:00.000Z' });
    t.clock.advance(SERVER_CHECK_MS);
    await t.login.check();
    expect(t.texts().filter((text) => text.includes('birch'))).toHaveLength(2);
  });

  it('holds back expiry warnings in quiet hours, but not sign-outs', async () => {
    const t = setup({ ash: { logged_in: true, email: 'o@x', expires_at: '2026-11-08T06:01:23.415Z' }, hq: SIGNED_OUT });
    t.clock.set('2026-11-07T22:00:00.000Z'); // 2:00 AM owner time
    await t.login.check();
    expect(t.texts()).toEqual(["🔴 *Luady is signed out of Claude* and can't answer. Send /login to sign in."]);
  });

  it('a failing host check does not stop the others', async () => {
    const t = setup({}, { authStatus: async () => { throw new Error('ssh down'); } });
    await expect(t.login.check()).resolves.toBeUndefined();
    expect(t.texts()).toEqual([]);
  });

  it('retries a failed server check on the next tick instead of an hour later', async () => {
    let fail = true;
    const t = setup({}, {
      authStatus: async () => {
        if (fail) throw new Error('old kit');
        return SIGNED_OUT;
      },
    });
    await t.login.check();
    fail = false;
    await t.login.check();
    expect(t.texts()).toContain("🔴 *cedar is signed out of Claude*, so its sessions can't work. Send /login cedar to sign in.");
  });
});

describe('whenText', () => {
  const now = new Date(T0);
  it('says today, tomorrow or the weekday in owner time', () => {
    expect(whenText(new Date('2026-11-07T10:30:00.000Z'), now)).toBe('today 2:30 PM');
    expect(whenText(new Date('2026-11-08T06:01:00.000Z'), now)).toBe('tomorrow 10:01 AM');
    expect(whenText(new Date('2026-11-10T06:01:00.000Z'), now)).toBe('Tue 10:01 AM');
  });
});

const TEAM_B: CtlAuthStatus = { logged_in: true, email: 'o@x', expires_at: '2026-12-30T00:00:00.000Z', org_id: 'org_team_b', org_name: 'Team B', plan: 'team' };
const MOVED = '🔐 cedar is now signed in to Team B (team). If that was not you, sign it out.';

describe('claude login service: a host that moves to another account', () => {
  it('a check that finds another organisation sends exactly one chat message; the next checks send none', async () => {
    const t = setup();
    await t.login.check();
    expect(t.texts()).toEqual([]);
    t.auth.set('cedar', TEAM_B);
    t.clock.advance(SERVER_CHECK_MS);
    await t.login.check();
    t.clock.advance(SERVER_CHECK_MS);
    await t.login.check();
    expect(t.texts()).toEqual([MOVED]);
  });

  it('the same account signing in again sends nothing, even after a sign-out', async () => {
    const t = setup({}, { authCode: async () => ({ ok: true, message: 'Login successful', ...TEAM_B }) });
    t.auth.set('cedar', TEAM_B);
    await t.login.check();
    await t.login.logout('cedar');
    await t.login.begin('cedar');
    await t.login.submit('cedar', CODE);
    expect(t.texts()).toEqual([]);
  });

  it('remembers the account across a hub restart: a host found on another one after it is reported once', async () => {
    const first = setup();
    await first.login.check();
    const second = setup({ cedar: TEAM_B }, {}, first.db);
    await second.login.check();
    expect(second.texts()).toEqual([MOVED]);
  });

  it("Luady's own account changing is reported before the brain restarts on it", async () => {
    const t = setup({}, { authCode: async () => ({ ok: true, message: 'Login successful', ...TEAM_B }) });
    await t.login.check();
    await t.login.begin('hq');
    await t.login.submit('hq', CODE);
    const message = '🔐 Luady is now signed in to Team B (team). If that was not you, sign it out.';
    expect(t.order.filter((entry) => entry.startsWith('chat:') || entry === 'rotate')).toEqual([`chat:${message}`, 'rotate']);
  });

  it('a kit that starts reporting an organisation for the same e-mail is not a move', async () => {
    const t = setup({ birch: { logged_in: true, email: 'o@x', expires_at: null } });
    await t.login.check();
    t.auth.set('birch', { logged_in: true, email: 'O@X', expires_at: null, org_id: 'org_birch', org_name: 'Team A', plan: 'team' });
    t.clock.advance(SERVER_CHECK_MS);
    await t.login.check();
    expect(t.texts()).toEqual([]);
  });

  it('every finished sign-in is audited with the host and the new account, never the code', async () => {
    const t = setup({}, {
      authCode: async (code) => (code === CODE
        ? { ok: true, message: `Login successful ${CODE}`, ...TEAM_B }
        : { ok: false, message: 'Invalid code', ...SIGNED_OUT }),
    });
    await t.login.begin('cedar');
    await t.login.submit('cedar', WRONG);
    expect(t.audit).not.toHaveBeenCalled();
    await t.login.submit('cedar', CODE);
    expect(t.audit).toHaveBeenCalledTimes(1);
    expect(t.audit).toHaveBeenCalledWith({ host: 'cedar', summary: 'cedar signed in to Team B (team)', via: 'web' });
    expect(JSON.stringify(t.audit.mock.calls)).not.toContain(CODE.split('#')[0]);
  });
});

describe('claude login service: limits follow the account', () => {
  it('tells the limits a host moved to another account or signed out, not when the same account is seen again', async () => {
    const t = setup();
    await t.login.check();
    expect(t.accountChanges).toEqual([]);
    t.auth.set('cedar', TEAM_B);
    t.auth.set('birch', SIGNED_OUT);
    t.clock.advance(SERVER_CHECK_MS);
    await t.login.check();
    t.clock.advance(SERVER_CHECK_MS);
    await t.login.check();
    expect(t.accountChanges.sort()).toEqual(['birch', 'cedar']);
    await t.login.logout('ash');
    expect(t.accountChanges.sort()).toEqual(['ash', 'birch', 'cedar']);
  });
});

describe('claude login service: one code per host at a time, counted before it is sent', () => {
  it('a second code while the first is still being checked never reaches the kit', async () => {
    let finish: (value: { ok: boolean; message: string } & CtlAuthStatus) => void = () => undefined;
    const t = setup({}, { authCode: () => new Promise((resolve) => { finish = resolve; }) });
    await t.login.begin('cedar');
    const first = t.login.submit('cedar', WRONG);
    const second = await t.login.submit('cedar', CODE);
    expect(second).toMatchObject({ ok: false, message: 'A code is already being checked for this sign-in. Wait for its answer.' });
    finish({ ok: false, message: 'Invalid code', ...SIGNED_OUT });
    expect(await first).toMatchObject({ ok: false, message: 'Invalid code' });
    expect(t.client('cedar').calls.filter((c) => c.method === 'authCode').map((c) => c.args[0])).toEqual([WRONG]);
  });

  it('twelve concurrent wrong codes make at most five kit calls', async () => {
    const t = setup();
    await t.login.begin('cedar');
    await Promise.all(Array.from({ length: 12 }, () => t.login.submit('cedar', WRONG)));
    expect(t.client('cedar').calls.filter((c) => c.method === 'authCode').length).toBeLessThanOrEqual(CODE_ATTEMPTS_MAX);
  });

  it('the sixth try is refused before the kit is asked', async () => {
    const t = setup();
    await t.login.begin('cedar');
    for (let i = 0; i < CODE_ATTEMPTS_MAX; i += 1) await t.login.submit('cedar', WRONG);
    expect(await t.login.submit('cedar', CODE)).toMatchObject({ ok: false, message: 'Too many tries. Start a new sign-in.' });
    expect(t.client('cedar').calls.filter((c) => c.method === 'authCode')).toHaveLength(CODE_ATTEMPTS_MAX);
  });
});

describe('claude login service: code hygiene', () => {
  it('scrubs the code from a kit error before cutting it to length, so no part of it survives the cut', async () => {
    const t = setup({}, { authCode: async (code) => { throw new CtlError('failed', `${'x'.repeat(280)} ${code}`, 1); } });
    await t.login.begin('cedar');
    const result = await t.login.submit('cedar', CODE);
    expect(result.message).not.toContain(CODE.slice(0, 12));
    expect(result.message.length).toBeLessThanOrEqual(300);
  });

  it('trims whitespace around a pasted code before it is checked or sent', async () => {
    const t = setup();
    await t.login.begin('cedar');
    expect((await t.login.submit('cedar', `  ${CODE}  `)).ok).toBe(true);
    expect(t.client('cedar').calls.find((c) => c.method === 'authCode')?.args).toEqual([CODE]);
  });
});
