import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelInfoDTO, HostId, ServerDTO } from '@luady/shared';
import { classicOfficeName } from '../helpers/classic-rooms.js';
import { createLimitsStore } from '../../src/accounts/limits.js';
import { ACCOUNTS_CHANGED_MIN_MS, createAccountsService, type AccountsDeps, type AccountsService } from '../../src/accounts/service.js';
import { createBus } from '../../src/core/bus.js';
import type { HubEvents } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import type { LoginStatus } from '../../src/claude-login/status.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';

const T0 = '2026-11-14T09:00:00.000Z';
const RESET = '2026-11-14T11:20:00.000Z';

function server(name: ServerDTO['name'], kitVersion: string | null): ServerDTO {
  return { name, host: name, status: 'online', lastSeenAt: null, claudeVersion: null, kitVersion, sysinfo: null };
}

function loginStatus(host: HostId, orgId: string): LoginStatus {
  return { host, loggedIn: true, email: 'o@x', orgId, orgName: null, plan: 'max', expiresAt: null, checkedAt: T0 };
}

function setup(over: Partial<AccountsDeps> = {}, codexStatus: 'in' | 'out' | 'unknown' = 'unknown') {
  const clock = createFakeClock(T0);
  const bus = createBus();
  const changes: Array<HubEvents['accounts.changed']> = [];
  bus.on('accounts.changed', (event) => changes.push(event));
  let codexListener: (ok: boolean) => void = () => undefined;
  // The declared chat channel (channels()): one connection row.
  let channel: ChannelInfoDTO = { ...CHAT_CHANNEL, state: 'up', detail: 'open' };
  const deps: AccountsDeps = {
    bus, clock, log: silentLogger(),
    fleet: { servers: () => [server('cedar', '2.0.0'), server('ash', '1.4.0')] },
    login: { statuses: () => [loginStatus('hq', 'org_luady'), loginStatus('cedar', 'org_max'), loginStatus('ash', 'org_team')], pending: (host) => (host === 'cedar' ? { host, url: 'https://x.invalid/a', expiresAt: T0 } : null) },
    limits: createLimitsStore(openMemoryDb()),
    codex: {
      status: async () => codexStatus,
      onResult: (listener) => {
        codexListener = listener;
        return () => undefined;
      },
    },
    channels: () => [channel],
    google: { accounts: () => [{ email: 'a@x', label: 'personal' }, { email: 'b@x', label: 'work' }] },
    imapLabel: 'Hotmail',
    wisprConnected: () => false,
    officeName: classicOfficeName,
    ...over,
  };
  const service = createAccountsService(deps);
  const meters = (host: HostId, five: number | null, at: string = clock.now().toISOString()): void => {
    bus.emit('meters.updated', {
      host, sessionId: `${host}:s`, at,
      fiveHour: five === null ? null : { usedPct: five, resetsAt: RESET }, sevenDay: null,
    });
  };
  return {
    service, bus, clock, changes, meters, finishCodex: (ok: boolean) => codexListener(ok),
    setChannel: (state: ChannelInfoDTO['state'], detail: string | null) => { channel = { ...channel, state, detail }; },
  };
}

const CHAT_CHANNEL: ChannelInfoDTO = {
  id: 'test-channel', kind: 'channel', name: 'Test chat', state: 'up', detail: null, since: T0, primary: true, capabilities: null, panel: null,
};

const running: AccountsService[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
  for (const service of running.splice(0)) service.stop();
  vi.useRealTimers();
});

function started(t: ReturnType<typeof setup>): ReturnType<typeof setup> {
  t.service.start();
  running.push(t.service);
  return t;
}

describe('the ChatGPT sign-in for pictures', () => {
  it('carries one line to sign in again while an old sign-in is not used, and none once signed in', async () => {
    const out = setup({ codexNote: () => 'Connect ChatGPT (pictures) again.' }, 'out');
    expect((await out.service.list()).accounts.at(-1)?.note).toBe('Connect ChatGPT (pictures) again.');
    const signedIn = setup({ codexNote: () => 'Connect ChatGPT (pictures) again.' }, 'in');
    expect((await signedIn.service.list()).accounts.at(-1)?.note).toBeUndefined();
    const none = setup({ codexNote: () => null }, 'out');
    expect((await none.service.list()).accounts.at(-1)).not.toHaveProperty('note');
  });
});

describe('accounts service: limits from meters', () => {
  it('a meters reading with new limits emits one accounts.changed', () => {
    const t = started(setup());
    t.meters('cedar', 62);
    expect(t.changes).toEqual([{ at: T0 }]);
  });

  it('ten readings within 30 seconds emit two in total: the first and one trailing', async () => {
    const t = started(setup());
    for (let i = 0; i < 10; i += 1) {
      t.meters('cedar', 10 + i);
      t.clock.advance(2_000);
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(t.changes).toHaveLength(1);
    t.clock.advance(ACCOUNTS_CHANGED_MIN_MS);
    await vi.advanceTimersByTimeAsync(ACCOUNTS_CHANGED_MIN_MS);
    expect(t.changes).toHaveLength(2);
    expect((await t.service.list()).accounts.find((a) => a.id === 'claude:org_max')?.limits.fiveHour?.usedPct).toBe(19);
  });

  it('a reading that changes nothing emits none', () => {
    const t = started(setup());
    t.meters('cedar', 62);
    t.clock.advance(ACCOUNTS_CHANGED_MIN_MS);
    t.meters('cedar', 62.5);
    expect(t.changes).toHaveLength(1);
  });

  it('a finished Codex sign-in emits accounts.changed', () => {
    const t = started(setup());
    t.finishCodex(true);
    expect(t.changes).toHaveLength(1);
  });

  it('stop drops the subscriptions and the trailing emit', async () => {
    const t = started(setup());
    t.meters('cedar', 10);
    t.meters('cedar', 20);
    t.service.stop();
    t.meters('cedar', 30);
    await vi.advanceTimersByTimeAsync(ACCOUNTS_CHANGED_MIN_MS);
    expect(t.changes).toHaveLength(1);
  });
});

describe('accounts service: list', () => {
  it('Claude accounts with pending sign-ins and kit checks, the Codex account and four connections', async () => {
    const t = setup();
    const list = await t.service.list();
    expect(list.accounts.map((a) => a.id)).toEqual(['claude:org_luady', 'claude:org_team', 'claude:org_max', 'codex']);
    const max = list.accounts.find((a) => a.id === 'claude:org_max');
    expect(max?.hosts[0]).toMatchObject({ host: 'cedar', loginPending: true, canLogout: true });
    expect(list.accounts.find((a) => a.id === 'claude:org_team')?.hosts[0]?.canLogout).toBe(false);
    expect(list.accounts.find((a) => a.id === 'claude:org_luady')?.hosts[0]?.canLogout).toBe(true);
    expect(list.accounts.at(-1)).toEqual({
      id: 'codex', provider: 'codex', email: null, orgName: null, plan: 'ChatGPT', isManager: false,
      hosts: [{ host: 'hq', loggedIn: null, expiresAt: null, checkedAt: T0, loginPending: false, canLogout: true }],
      limits: { reported: 'unknown', fiveHour: null, sevenDay: null, updatedAt: null },
    });
    expect(list.connections).toEqual([
      { id: 'test-channel', label: 'Test chat', state: 'connected', detail: 'open', connectUrl: null },
      { id: 'google', label: 'Gmail and Calendar', state: 'connected', detail: 'personal, work', connectUrl: null },
      { id: 'imap', label: 'Mailbox', state: 'connected', detail: 'Hotmail', connectUrl: null },
      { id: 'wispr', label: 'Wispr Flow', state: 'not_connected', detail: 'Send /wispr to Luady to connect', connectUrl: null },
    ]);
  });

  it('one row per declared channel (none without channels), and the connect flow\'s page on Google and Wispr', async () => {
    const connectUrl = (service: string): string => `https://hub.example.com/settings?connect=${service}`;
    const linked = await setup({ connectUrl, channels: () => [CHAT_CHANNEL, { ...CHAT_CHANNEL, id: 'other-chat', name: 'Other', state: 'absent' }] }).service.list();
    expect(linked.connections.map((row) => [row.id, row.state, row.connectUrl])).toEqual([
      ['test-channel', 'connected', null], ['other-chat', 'unavailable', null],
      ['google', 'connected', 'https://hub.example.com/settings?connect=google'], ['imap', 'connected', null],
      ['wispr', 'not_connected', 'https://hub.example.com/settings?connect=wispr'],
    ]);
    const none = await setup({ channels: () => [] }).service.list();
    expect(none.connections.map((row) => row.id)).toEqual(['google', 'imap', 'wispr']);
  });

  it('Codex in and out; Google, the mailbox and Wispr when not configured or not connected', async () => {
    expect((await setup({}, 'in').service.list()).accounts.at(-1)?.hosts[0]?.loggedIn).toBe(true);
    expect((await setup({}, 'out').service.list()).accounts.at(-1)?.hosts[0]?.loggedIn).toBe(false);
    const t = setup({ google: null, imapLabel: null, wisprConnected: () => true });
    t.setChannel('down', null);
    const { connections } = await t.service.list();
    expect(connections).toEqual([
      { id: 'test-channel', label: 'Test chat', state: 'not_connected', detail: 'down', connectUrl: null },
      { id: 'google', label: 'Gmail and Calendar', state: 'unavailable', detail: null, connectUrl: null },
      { id: 'imap', label: 'Mailbox', state: 'unavailable', detail: null, connectUrl: null },
      { id: 'wispr', label: 'Wispr Flow', state: 'connected', detail: null, connectUrl: null },
    ]);
    const none = await setup({ google: { accounts: () => [] } }).service.list();
    expect(none.connections[1]).toMatchObject({ state: 'not_connected', detail: null });
  });

  it('one Jira row per connected office, with the site or the last error', async () => {
    const site = { baseUrl: 'https://orchard-demo.atlassian.net', email: 'o@x', displayName: 'Alex', connectedAt: T0, lastOkAt: T0, attention: null };
    const t = setup({ jiraSites: () => [
      { ...site, server: 'birch', lastError: null },
      { ...site, server: 'ash', baseUrl: 'https://harbor-demo.atlassian.net', displayName: null, lastError: 'Jira refused the sign-in. The token may have expired.' },
    ] });
    const jira = (await t.service.list()).connections.filter((c) => c.id === 'jira');
    expect(jira).toEqual([
      { id: 'jira', label: 'Jira · Orchard', state: 'connected', detail: 'orchard-demo.atlassian.net as Alex', connectUrl: null },
      { id: 'jira', label: 'Jira · Harbor', state: 'connected', detail: 'Jira refused the sign-in. The token may have expired.', connectUrl: null },
    ]);
  });

  it('limitsText is one line per Claude account', async () => {
    const t = started(setup());
    t.meters('cedar', 62);
    const text = await t.service.limitsText();
    expect(text.split('\n')).toEqual([
      'Max (Luady) · no reading yet',
      'Max (ash) · no reading yet',
      'Max (cedar) · 5h 62% (resets 3:20 PM) · week unknown',
    ]);
  });
});

describe('accounts service: a reading from a signed-out host', () => {
  it('is not merged into any account', () => {
    const t = started(setup({
      login: { statuses: () => [{ ...loginStatus('cedar', 'org_max'), loggedIn: false, orgId: null, email: null }], pending: () => null },
    }));
    t.meters('cedar', 62);
    expect(t.changes).toEqual([]);
  });
});

describe('accounts service: readings are ordered by the hub clock', () => {
  it('a reading dated in the future counts as now, so the next real reading is still taken', async () => {
    const t = started(setup());
    t.meters('cedar', 62, '2026-11-14T10:00:00.000Z');
    t.clock.advance(1_000);
    t.meters('cedar', 70);
    const cedar = (await t.service.list()).accounts.find((a) => a.id === 'claude:org_max');
    expect(cedar?.limits).toMatchObject({ fiveHour: { usedPct: 70 }, updatedAt: '2026-11-14T09:00:01.000Z' });
  });
});
