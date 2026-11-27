import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type CtlAuthStatus, type HostId, type ServerDTO } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { CtlClient } from '../../src/core/contracts.js';
import { CtlError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { LOGIN_WAIT_MS, createClaudeLoginService } from '../../src/claude-login/service.js';
import { noLoginWaiting } from '../../src/claude-login/text.js';
import { createChatLogin } from '../../src/claude-login/chat-login.js';

/** The fleet's hosts a chat sign-in can name. */
const HOSTS = ['cedar', 'birch', 'ash', 'local'];
import { createFakeClock, createFakeCtl, createFakeOutbound, silentLogger } from '../helpers/fakes.js';

// 2026-11-07 10:00 AM owner time
const T0 = '2026-11-07T06:00:00.000Z';
const URL = 'https://claude.com/cai/oauth/authorize?code=true&state=s1';
const CODE = 'test-auth-code-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#test-state-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';

function server(name: ServerDTO['name']): ServerDTO {
  return { name, host: name, status: 'online', lastSeenAt: null, claudeVersion: null, kitVersion: null, sysinfo: null };
}

function setup(statuses: Partial<Record<HostId, CtlAuthStatus>> = {}, over: Partial<CtlClient> = {}) {
  const clock = createFakeClock(T0);
  const clients = new Map<HostId, ReturnType<typeof createFakeCtl>>();
  const client = (host: HostId) => {
    const existing = clients.get(host);
    if (existing) return existing;
    const created = createFakeCtl({
      authStatus: async () => statuses[host] ?? { logged_in: true, email: 'o@x', expires_at: '2026-12-30T00:00:00.000Z' },
      authLogin: async () => ({ url: URL }),
      ...over,
    });
    clients.set(host, created);
    return created;
  };
  const rotate = vi.fn(async (_force?: boolean) => true);
  const service = createClaudeLoginService({
    db: openMemoryDb(), clock, log: silentLogger(), bus: createBus(), fleet: { client, servers: () => [server('cedar'), server('birch'), server('ash')] },
    outbound: createFakeOutbound(), settings: { get: () => DEFAULT_SETTINGS }, luady: { rotate, release: vi.fn(async () => undefined) },
    hosts: () => ['hq', 'cedar', 'birch', 'ash', 'local'],
  });
  return { chat: createChatLogin(service, clock, () => HOSTS), service, clock, client, rotate };
}

describe('chat /login on top of the login service', () => {
  it('a code with nothing waiting, or after 30 minutes, answers the no-sign-in text and reaches no kit', async () => {
    const t = setup();
    expect(await t.chat.submit(CODE, 'test-channel')).toBe(noLoginWaiting(HOSTS));
    await t.service.begin('cedar');
    t.clock.advance(LOGIN_WAIT_MS);
    expect(await t.chat.submit(CODE, 'test-channel')).toBe(noLoginWaiting(HOSTS));
    expect(t.client('cedar').calls.map((c) => c.method)).toEqual(['authLogin']);
  });

  it('signs a signed-out Luady in and restarts it', async () => {
    const t = setup({ hq: { logged_in: false, email: null, expires_at: null } });
    await t.service.check();
    expect(t.service.brainSignedOut()).toBe(true);
    await t.service.begin('hq');
    expect(await t.chat.submit(CODE, 'test-channel')).toBe('✅ *Luady is signed in* until Tue 4:00 AM. Restarting Luady now.');
    expect(t.rotate).toHaveBeenCalledWith(true);
  });

  it('a code goes to the newest sign-in: cedar from the website, then birch from the chat', async () => {
    const t = setup();
    await t.service.begin('cedar');
    t.clock.advance(1_000);
    await t.service.begin('birch');
    expect(await t.chat.submit(CODE, 'test-channel')).toBe('✅ *birch is signed in* until Tue 4:00 AM. Its sessions carry on.');
    expect(t.client('cedar').calls.map((c) => c.method)).toEqual(['authLogin']);
    expect(t.service.pending('cedar')).not.toBeNull();
  });

  it("a rejected code, an ended sign-in and a usage error each answer with their own text", async () => {
    const rejected = setup({}, { authCode: async () => ({ ok: false, message: 'OAuth error: Invalid code', logged_in: false, email: null, expires_at: null }) });
    await rejected.service.begin('birch');
    expect(await rejected.chat.submit(CODE, 'test-channel')).toBe('❌ Sign-in failed: OAuth error: Invalid code\nSend /login birch to try again.');

    const ended = setup({}, { authCode: async () => { throw new CtlError('not_found', 'no sign-in is waiting', 4); } });
    await ended.service.begin('birch');
    expect(await ended.chat.submit(CODE, 'test-channel')).toBe('❌ Sign-in failed: no sign-in is waiting\nSend /login birch to try again.');
    expect(await ended.chat.submit(CODE, 'test-channel')).toBe(noLoginWaiting(HOSTS));

    const usage = setup({}, { authCode: async () => { throw new CtlError('usage', 'bad', 2); } });
    await usage.service.begin('ash');
    expect(await usage.chat.submit(CODE, 'test-channel')).toBe("That doesn't look like the sign-in code. Copy the whole code and send it again.");
  });
});
