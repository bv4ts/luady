import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type ChatMessageDTO, type CtlAuthStatus, type HostId, type SpoolEvent } from '@luady/shared';
import { createClaudeLoginService, type ClaudeLoginService } from '../../src/claude-login/service.js';
import { createBus } from '../../src/core/bus.js';
import type { CtlClient, Db, Fleet, HubConfig, MemoryService } from '../../src/core/contracts.js';
import { newId } from '../../src/core/ids.js';
import { openMemoryDb } from '../../src/db/open.js';
import { FLUSH_GAP_MS } from '../../src/luady/inbox.js';
import { createLuadyService, type TmuxRunner } from '../../src/luady/service.js';
import { createFakeCtl, createFakeOutbound, silentLogger, classicHostLookups } from '../helpers/fakes.js';

const T0 = '2026-10-09T12:00:00.000Z'; // Fri 4:00 PM in owner time
const CODE = 'test-auth-code-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#test-state-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
const IN: CtlAuthStatus = { logged_in: true, email: 'o@x', expires_at: null, org_id: 'org_luady', org_name: 'Luady', plan: 'max' };
const OUT: CtlAuthStatus = { logged_in: false, email: null, expires_at: null };
const config = { brainDir: '/home/luady/brain', claudePath: '/home/luady/.local/bin/claude' } as unknown as HubConfig;

function memory(db: Db): MemoryService {
  return {
    record: (msg) => {
      const dto: ChatMessageDTO = { id: newId(), thread: msg.thread, role: msg.role, channel: msg.channel, text: msg.text, ts: new Date().toISOString() };
      db.prepare('INSERT INTO messages (id, thread, role, channel, text, ts, ext_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(dto.id, dto.thread, dto.role, dto.channel, dto.text, dto.ts, null);
      return dto;
    },
    search: () => [],
  };
}

const sessionStart = (sid: string): SpoolEvent => ({
  v: 1, id: `start-${sid}`, ts: T0, host: 'hq', session_id: sid, cwd: '/home/luady/brain', transcript_path: null, tmux: 'manager:0.0',
  permission_mode: 'dontAsk', event: 'session_start', data: { source: 'startup', model: 'opus' },
});

/** The real brain service and the real sign-in service, wired as in app.ts; only tmux, the kit and the chat are fakes. */
function hub(db: Db = openMemoryDb(), startOut = false) {
  const bus = createBus();
  let auth: CtlAuthStatus = startOut ? OUT : IN;
  const ctl: CtlClient & { calls: Array<{ method: string; args: unknown[] }> } = createFakeCtl({
    authStatus: async () => auth,
    authLogout: async () => {
      auth = OUT;
      return { ok: true, message: 'Signed out', ...OUT };
    },
    authCode: async () => {
      auth = IN;
      return { ok: true, message: 'Login successful', ...IN };
    },
  });
  const fleet: Fleet = {
    start: vi.fn(), stop: vi.fn(), client: (_host: HostId) => ctl, servers: () => [], openShell: vi.fn(), ...classicHostLookups(), tailEvents: vi.fn(),
  };
  const tmuxState = { alive: true };
  const tmux: TmuxRunner = {
    run: async (args) => {
      if (args[0] === 'has-session') return { code: tmuxState.alive ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'kill-session') tmuxState.alive = false;
      if (args[0] === 'new-session') tmuxState.alive = true;
      return { code: 0, stdout: args[0] === 'display-message' ? 'claude\n' : '', stderr: '' };
    },
  };
  const seen: ChatMessageDTO[] = [];
  bus.on('manager.message', (message) => seen.push(message));
  let loginRef: ClaudeLoginService | null = null;
  const luady = createLuadyService({
    config, db, bus, clock: { now: () => new Date() }, log: silentLogger(), fleet, outbound: createFakeOutbound(), memory: memory(db), tmux,
    notices: { post: vi.fn(async () => ({ notice: null, msgId: null })), capable: () => true },
    settings: { get: () => DEFAULT_SETTINGS, update: vi.fn() },
    signedOut: () => loginRef?.brainSignedOut() === true,
  });
  const login = createClaudeLoginService({
    db, clock: { now: () => new Date() }, log: silentLogger(), bus, fleet, outbound: createFakeOutbound(),
    settings: { get: () => DEFAULT_SETTINGS }, luady, hosts: () => ['hq'],
  });
  loginRef = login;
  const toBrain = (): unknown[] => ctl.calls.filter((c) => c.method === 'send').map((c) => c.args[1]);
  const queued = (): number => (db.prepare('SELECT COUNT(*) AS n FROM manager_queue').get() as { n: number }).n;
  /** The relaunched brain reports in, then the queue is flushed one group a second. */
  const brainUp = async (sid: string): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
    bus.emit('spool.event', { host: 'hq', event: sessionStart(sid), replay: false });
    await vi.advanceTimersByTimeAsync(5 * FLUSH_GAP_MS);
  };
  /** Someone signs Luady in at the terminal: only the next check, refresh or code sees it. */
  const terminalLogin = (): void => {
    auth = IN;
  };
  return { db, bus, luady, login, toBrain, queued, seen, brainUp, terminalLogin };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('everything meant for the brain is held while Luady is signed out (real path)', () => {
  it('website chat, the chat and Events wait in the queue, and reach the brain in order after the sign-in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: new Date(T0) });
    const t = hub();
    await t.luady.start();
    await t.login.logout('hq');
    await t.luady.postOwnerMessage('from the website', 'web');
    await t.luady.postOwnerMessage('from the chat', 'test-channel');
    await t.luady.postEvent('Your mission cedar · x finished a turn.', 'Event');
    expect(t.toBrain()).toEqual([]);
    expect(t.queued()).toBe(3);
    expect(t.seen.map((m) => [m.role, m.text])).toEqual([['owner', 'from the website'], ['owner', 'from the chat']]);
    await t.login.begin('hq');
    expect(await t.login.submit('hq', CODE)).toMatchObject({ ok: true, brainRestarted: true });
    await t.brainUp('c-after-sign-in');
    expect(t.toBrain()).toEqual([
      '[Web · Fri 16:00] from the website',
      '[Chat · Fri 16:00] from the chat',
      expect.stringMatching(/^\[Event · Fri 16:00\] Your mission cedar · x finished a turn\./),
    ]);
    expect(t.queued()).toBe(0);
    await t.luady.stop();
  });
});

describe('kept messages reach Luady whenever it is signed in again, and survive a restart (real path)', () => {
  it.for(['check', 'refresh'] as const)('a sign-in found by the %s restarts the brain and passes them on', async (how) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: new Date(T0) });
    const t = hub();
    await t.luady.start();
    await t.login.logout('hq');
    await t.luady.postOwnerMessage('are you there?', 'test-channel');
    t.terminalLogin();
    if (how === 'check') await t.login.check();
    else await t.login.refresh('hq');
    expect(t.login.brainSignedOut()).toBe(false);
    await t.brainUp(`c-${how}`);
    expect(t.toBrain()).toEqual(['[Chat · Fri 16:00] are you there?']);
    await t.luady.stop();
  });

  it('a hub restart keeps them held (the brain starts but gets nothing) until a check finds Luady signed in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: new Date(T0) });
    const db = openMemoryDb();
    const before = hub(db);
    await before.luady.start();
    await before.login.logout('hq');
    await before.luady.postOwnerMessage('kept over a deploy', 'web');
    await before.luady.stop();
    const after = hub(db, true);
    expect(after.login.brainSignedOut()).toBe(true);
    await after.luady.start();
    await after.brainUp('c-restarted');
    expect(after.toBrain()).toEqual([]);
    expect(after.queued()).toBe(1);
    after.terminalLogin();
    await after.login.check();
    await after.brainUp('c-signed-in');
    expect(after.toBrain()).toEqual(['[Web · Fri 16:00] kept over a deploy']);
    await after.luady.stop();
  });
});
