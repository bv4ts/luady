import type { AccountDTO, AccountsDTO } from '@luady/shared';
import { screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../../src/api/errors.js';
import { AccountsDrawer } from '../../../../src/features/agency/drawers/AccountsDrawer.js';
import { useAccounts } from '../../../../src/features/agency/drawers/useAccounts.js';
import { useStore } from '../../../../src/state/store.js';
import { account, accountHost, accounts, action } from '../../../fixtures.js';
import { fakeApi, type FakeApiOverrides } from '../../../helpers/fake-api.js';
import { renderPage } from '../../../helpers/render.js';

const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
const live = (five: number, week: number): AccountDTO['limits'] => ({
  reported: 'yes', fiveHour: { usedPct: five, resetsAt: soon(2) }, sevenDay: { usedPct: week, resetsAt: soon(50) }, updatedAt: soon(0),
});

const LUADY: AccountDTO = account({
  id: 'claude:org_luady', email: 'luady@example.com', orgName: 'Luady', isManager: true,
  hosts: [accountHost({ host: 'local' }), accountHost({ host: 'hq' })], limits: live(20, 10),
});
const CEDAR: AccountDTO = account({ limits: live(62, 41) });
const BIRCH: AccountDTO = account({
  id: 'claude:org_team_a', email: null, orgName: 'Team A', plan: 'team',
  hosts: [accountHost({ host: 'birch', canLogout: false })], limits: { reported: 'no', fiveHour: null, sevenDay: null, updatedAt: soon(0) },
});
const ASH: AccountDTO = account({
  id: 'claude:host:ash', email: null, orgName: null, plan: null,
  hosts: [accountHost({ host: 'ash', loggedIn: false, expiresAt: null })], limits: { reported: 'unknown', fiveHour: null, sevenDay: null, updatedAt: null },
});
const CODEX: AccountDTO = account({
  id: 'codex', provider: 'codex', email: null, orgName: null, plan: 'ChatGPT',
  hosts: [accountHost({ host: 'hq', loggedIn: false, expiresAt: null })], limits: { reported: 'unknown', fiveHour: null, sevenDay: null, updatedAt: null },
});

const fullList = (): AccountsDTO => accounts({
  accounts: [CEDAR, BIRCH, ASH, LUADY, CODEX],
  connections: [
    { id: 'test-channel', label: 'Test chat', state: 'connected', detail: 'up', connectUrl: null },
    { id: 'google', label: 'Google', state: 'not_connected', detail: null, connectUrl: 'https://accounts.google.com/o/oauth2/auth' },
  ],
});

/** The drawer as the page mounts it: one useAccounts, its result handed down. */
function Host() {
  const state = useAccounts();
  const { state: store } = useStore();
  return (
    <>
      <AccountsDrawer accounts={state} />
      <output data-testid="toasts">{store.toasts.map((t) => t.text).join('|')}</output>
    </>
  );
}

/** The page keeps the accounts loaded; the drawer opens later. */
function LaterDrawer() {
  const state = useAccounts();
  const [shown, setShown] = useState(false);
  if (!shown) return <button type="button" onClick={() => setShown(true)}>{state.accounts === null ? 'loading' : 'open drawer'}</button>;
  return <AccountsDrawer accounts={state} />;
}

async function open(over: FakeApiOverrides = {}) {
  const api = fakeApi({ accounts: async () => fullList(), ...over });
  const harness = await renderPage(<Host />, { api });
  return { ...harness, drawer: screen.getByTestId('accounts-drawer') };
}

const cardOf = (name: string) => {
  const card = screen.getAllByTestId('account-card').find((c) => c.textContent?.includes(name));
  if (card === undefined) throw new Error(`no card for ${name}`);
  return card;
};

describe('AccountsDrawer', () => {
  it('lists Luady’s account first, then the others, then ChatGPT and the connections', async () => {
    await open();
    const titles = screen.getAllByTestId('account-card').map((c) => c.querySelector('h3')?.textContent);
    expect(titles).toEqual(['luady@example.com', 'owner@example.com', 'Team A', 'Not signed in']);
    expect(screen.getByText('ChatGPT (pictures)')).toBeTruthy();
    const google = screen.getByRole('link', { name: 'Connect Google' });
    expect(google.getAttribute('rel')).toBe('noopener noreferrer');
    expect(google.getAttribute('target')).toBe('_blank');
  });

  it('a shared account shows one line per server', async () => {
    await open();
    const luady = cardOf('luady@example.com');
    expect(within(luady).getByText(/^local · signed in/)).toBeTruthy();
    // The manager's own host reads as the manager's name, never as its raw id.
    expect(within(luady).getByText(/^Luady · signed in/)).toBeTruthy();
    expect(within(luady).queryByText(/^hq · /)).toBeNull();
  });

  it('limits: bars with the reset time, the note when the plan does not report them, "No reading yet." when unknown', async () => {
    await open();
    const cedar = cardOf('owner@example.com');
    expect(within(cedar).getByText(/^5-hour limit 62% · resets/)).toBeTruthy();
    expect(within(cedar).getAllByRole('meter')).toHaveLength(2);
    const birch = cardOf('Team A');
    expect(within(birch).getByText('This plan does not report limits.')).toBeTruthy();
    expect(within(birch).queryByRole('meter')).toBeNull();
    expect(within(cardOf('Not signed in')).getByText('No reading yet.')).toBeTruthy();
    expect(screen.getByTestId('accounts-drawer').textContent).not.toMatch(/NaN|\b0%/);
  });

  it('an expired window says so; a missing one says not reported; neither draws a bar', async () => {
    const expired = account({
      limits: { reported: 'yes', fiveHour: { usedPct: 97, resetsAt: soon(-1) }, sevenDay: null, updatedAt: soon(-2) },
    });
    await open({ accounts: async () => accounts({ accounts: [expired] }) });
    const card = cardOf('owner@example.com');
    expect(within(card).getByText(/^5-hour limit reset at .+, no new reading yet$/)).toBeTruthy();
    expect(within(card).getByText('Weekly limit not reported')).toBeTruthy();
    expect(within(card).queryByRole('meter')).toBeNull();
  });

  it('signs in with a link and a code, and clears the code after every try without ever showing it', async () => {
    const results = [
      { host: 'ash' as const, ok: false, message: 'Invalid code', loggedIn: false, expiresAt: null, brainRestarted: false },
      { host: 'ash' as const, ok: true, message: 'Signed in', loggedIn: true, expiresAt: soon(24 * 20), brainRestarted: false },
    ];
    const { user, api } = await open({
      loginAccount: async (host) => ({ host, url: 'https://claude.ai/oauth/authorize?code=true', expiresAt: soon(0.5) }),
      submitLoginCode: async () => results.shift() ?? results[0]!,
    });
    await user.click(within(cardOf('Not signed in')).getByTestId('account-login'));
    expect(api.loginAccount).toHaveBeenCalledWith('ash');
    const link = await screen.findByRole('link', { name: /claude\.ai/ });
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByText('Open the link and sign in')).toBeTruthy();
    const input = screen.getByTestId('account-code-input') as HTMLInputElement;
    expect(input.autocomplete).toBe('off');
    await user.type(input, 'secret-code-1111');
    await user.click(screen.getByTestId('account-code-submit'));
    expect(api.submitLoginCode).toHaveBeenCalledWith('ash', { code: 'secret-code-1111' });
    expect(await screen.findByText('Invalid code')).toBeTruthy();
    expect(input.value).toBe('');
    await user.type(input, 'secret-code-2222');
    await user.click(screen.getByTestId('account-code-submit'));
    expect(await screen.findByText(/^Signed in until /)).toBeTruthy();
    expect((screen.queryByTestId('account-code-input') as HTMLInputElement | null)?.value ?? '').toBe('');
    expect(screen.getByTestId('toasts').textContent).not.toMatch(/secret-code/);
    expect(document.body.textContent).not.toMatch(/secret-code/);
  });

  it('a sign-in on a signed-in server that the hub refuses for lack of a PIN asks for the PIN and starts again with it', async () => {
    let calls = 0;
    const { user, api } = await open({
      loginAccount: async (host) => {
        calls += 1;
        if (calls === 1) throw new ApiError(428, 'pin_required', 'PIN required: cedar is signed in');
        return { host, url: 'https://claude.ai/oauth/authorize?code=true', expiresAt: soon(0.5) };
      },
    });
    await user.click(within(cardOf('owner@example.com')).getByTestId('account-login'));
    const pin = await screen.findByRole('dialog', { name: 'Sign in cedar again' });
    expect(within(pin).getByText('A new sign-in can move this server to another account.')).toBeTruthy();
    await user.type(within(pin).getByLabelText('PIN'), '246813');
    await user.click(within(pin).getByRole('button', { name: 'Confirm' }));
    expect(api.loginAccount).toHaveBeenLastCalledWith('cedar', { pin: '246813' });
    expect(await screen.findByRole('link', { name: /claude\.ai/ })).toBeTruthy();
  });

  it('cancelling that PIN prompt leaves a plain line, not an error', async () => {
    const { user } = await open({ loginAccount: async () => { throw new ApiError(428, 'pin_required', 'PIN required'); } });
    await user.click(within(cardOf('owner@example.com')).getByTestId('account-login'));
    const pin = await screen.findByRole('dialog', { name: 'Sign in cedar again' });
    await user.click(within(pin).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Sign-in not started.')).toBeTruthy();
  });

  it('a finished sign-out says so in words', async () => {
    const { user } = await open({ logoutAccount: async () => action({ kind: 'account.logout', status: 'done', result: 'signed out' }) });
    await user.click(within(cardOf('owner@example.com')).getByTestId('account-logout'));
    await user.click(within(await screen.findByRole('dialog', { name: 'Sign cedar out of Claude?' })).getByRole('button', { name: 'Sign out' }));
    const pin = await screen.findByRole('dialog', { name: 'Sign out cedar' });
    await user.type(within(pin).getByLabelText('PIN'), '246813');
    await user.click(within(pin).getByRole('button', { name: 'Confirm' }));
    expect((await screen.findAllByText('Signed cedar out of Claude.')).length).toBeGreaterThan(0);
  });

  it('opening the drawer reads the accounts again (limit changes reach the page at most every 30 seconds)', async () => {
    const api = fakeApi({ accounts: async () => fullList() });
    const { user } = await renderPage(<LaterDrawer />, { api });
    await screen.findByText('open drawer');
    expect(api.accounts).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'open drawer' }));
    await screen.findAllByTestId('account-card');
    expect(api.accounts).toHaveBeenCalledTimes(2);
  });

  it('signing Luady out asks first in Luady’s words, then the PIN, and only then calls the hub', async () => {
    const { user, api } = await open({ logoutAccount: async () => action({ kind: 'account.logout', status: 'done', result: 'signed out' }) });
    const luady = cardOf('luady@example.com');
    const buttons = within(luady).getAllByTestId('account-logout');
    await user.click(buttons[1]!);
    const confirm = await screen.findByRole('dialog', { name: 'Sign Luady out?' });
    expect(within(confirm).getByText('Luady goes quiet until you sign in again. Messages you send meanwhile are kept and passed on.')).toBeTruthy();
    expect(api.logoutAccount).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Sign out' }));
    const pin = await screen.findByRole('dialog', { name: 'Sign out Luady' });
    expect(api.logoutAccount).not.toHaveBeenCalled();
    await user.type(within(pin).getByLabelText('PIN'), '246813');
    await user.click(within(pin).getByRole('button', { name: 'Confirm' }));
    expect(api.logoutAccount).toHaveBeenCalledWith('hq', { pin: '246813' });
  });

  it('a server sign-out uses the server wording', async () => {
    const { user } = await open();
    await user.click(within(cardOf('owner@example.com')).getByTestId('account-logout'));
    const confirm = await screen.findByRole('dialog', { name: 'Sign cedar out of Claude?' });
    expect(within(confirm).getByText('Its sessions stop working until you sign in again.')).toBeTruthy();
  });

  it('has no sign-out where the kit cannot do it', async () => {
    await open();
    expect(within(cardOf('Team A')).queryByTestId('account-logout')).toBeNull();
  });

  it('reloads once for each accounts.changed', async () => {
    const { ws, api } = await open();
    expect(api.accounts).toHaveBeenCalledTimes(1);
    ws.emit({ type: 'accounts.changed', at: soon(0) });
    await screen.findAllByTestId('account-card');
    expect(api.accounts).toHaveBeenCalledTimes(2);
  });

  it('a failing load shows a retry line, not a blank drawer', async () => {
    let fail = true;
    const { user } = await open({
      accounts: async () => {
        if (fail) throw new ApiError(502, 'http_502', 'Bad gateway');
        return fullList();
      },
    });
    expect(screen.getByText(/could not load/i)).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findAllByTestId('account-card')).toHaveLength(4);
  });

  it('an older hub without the accounts route says so, with no retry', async () => {
    await open({ accounts: async () => { throw new ApiError(404, 'not_found', 'Route not found'); } });
    expect(screen.getByText(/This hub cannot list accounts yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows the hub line to connect ChatGPT again when a sign-in made before is no longer used', async () => {
    const note = 'Pictures now use a ChatGPT sign-in of the hub’s own, kept in its data folder. Connect ChatGPT (pictures) again.';
    const list = fullList();
    const moved = { ...list, accounts: list.accounts.map((a) => (a.provider === 'codex' ? { ...a, note } : a)) };
    await open({ accounts: async () => moved });
    expect((await screen.findByTestId('codex-note')).textContent).toBe(note);
  });

  it('connects ChatGPT with a link and a device code', async () => {
    const { user } = await open({ codexLogin: async () => ({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234', expiresAt: soon(0.25) }) });
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('ABCD-1234')).toBeTruthy();
    expect(screen.getByText('Enter this code on that page')).toBeTruthy();
    expect(screen.getByRole('link', { name: /auth\.openai\.com/ }).getAttribute('rel')).toBe('noopener noreferrer');
  });
});
