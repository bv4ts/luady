import { describe, expect, it, vi } from 'vitest';
import type { HostId } from '@luady/shared';
import { createAccountActions } from '../../src/accounts/actions.js';
import { createBus } from '../../src/core/bus.js';
import type { HubEvents } from '../../src/core/contracts.js';
import { RefusedError } from '../../src/core/errors.js';
import { createFakeClock } from '../helpers/fakes.js';

const URL = 'https://claude.com/cai/oauth/authorize?code=true&state=s1';

function setup(over: { logoutOk?: boolean; codexOut?: boolean } = {}) {
  const bus = createBus();
  const changes: Array<HubEvents['accounts.changed']> = [];
  bus.on('accounts.changed', (event) => changes.push(event));
  const login = {
    begin: vi.fn(async (host: HostId) => ({ host, url: URL, expiresAt: '2026-10-09T12:30:00.000Z' })),
    logout: vi.fn(async (host: HostId) => ({
      host, ok: over.logoutOk ?? true, message: over.logoutOk === false ? 'Not signed in' : 'Signed out', loggedIn: false, expiresAt: null, brainRestarted: false,
    })),
  };
  const codex = {
    begin: vi.fn(async () => '🔑 Connect ChatGPT for images: open https://auth.openai.com/codex/device and enter *AB12-CD34Z*'),
    beginData: vi.fn(async () => ({ url: 'https://auth.openai.com/codex/device', code: 'AB12-CD34Z', expiresAt: '2026-10-09T12:15:00.000Z' })),
    logout: vi.fn(async () => over.codexOut ?? true),
  };
  const chatSent: string[] = [];
  const actions = createAccountActions({ login, codex, bus, clock: createFakeClock(), chat: async (text) => { chatSent.push(text); } });
  return { actions, login, codex, changes, chatSent };
}

describe('account actions for the action executor', () => {
  it('a sign-in answers "sign-in started" and never the link', async () => {
    const t = setup();
    expect(await t.actions.login('cedar')).toBe('sign-in started');
    expect(t.login.begin).toHaveBeenCalledWith('cedar');
    expect(await t.actions.login('codex')).toBe('sign-in started');
    expect(t.codex.beginData).toHaveBeenCalledTimes(1);
  });

  it('a sign-out answers "signed out", or fails the action with the kit message', async () => {
    expect(await setup().actions.logout('hq')).toBe('signed out');
    const refused = setup({ logoutOk: false });
    await expect(refused.actions.logout('cedar')).rejects.toThrow(new RefusedError('Not signed in'));
  });

  it('a Codex sign-out tells the website the accounts changed; a failed one fails the action', async () => {
    const t = setup();
    expect(await t.actions.logout('codex')).toBe('signed out');
    expect(t.changes).toEqual([{ at: '2026-10-09T12:00:00.000Z' }]);
    await expect(setup({ codexOut: false }).actions.logout('codex')).rejects.toThrow('ChatGPT did not sign out. Try again.');
  });
});

describe('a sign-in started from the chat', () => {
  it('sends the link (or the device code) on the chat itself; the result stays "sign-in started"', async () => {
    const t = setup();
    expect(await t.actions.login('cedar', 'test-channel')).toBe('sign-in started');
    expect(await t.actions.login('codex', 'test-channel')).toBe('sign-in started');
    expect(t.chatSent).toEqual([
      expect.stringContaining(URL),
      '🔑 Connect ChatGPT for images: open https://auth.openai.com/codex/device and enter *AB12-CD34Z*',
    ]);
    expect(t.codex.beginData).not.toHaveBeenCalled();
  });

  it('a website start sends nothing on the chat', async () => {
    const t = setup();
    await t.actions.login('cedar', 'web');
    await t.actions.login('codex', 'web');
    expect(t.chatSent).toEqual([]);
  });
});
