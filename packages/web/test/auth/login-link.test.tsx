import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PAGE_KEY_STORAGE } from '@luady/shared';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../src/api/context.js';
import { ApiError } from '../../src/api/errors.js';
import type { SetupApi } from '../../src/api/setup.js';
import { AuthGate } from '../../src/auth/AuthGate.js';
import { dropLinkToken, takeLinkToken } from '../../src/auth/link-token.js';
import { SetupApiProvider } from '../../src/features/setup/context.js';
import { me } from '../fixtures.js';
import { fakeApi } from '../helpers/fake-api.js';
import { fakeSetupApi, setupState } from '../helpers/fake-setup.js';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(), startRegistration: vi.fn(), browserSupportsWebAuthn: () => true,
  WebAuthnError: class WebAuthnError extends Error {},
}));

const TOKEN = 'Tk_9'.repeat(10).slice(0, 43);
const PAGE_KEY = 'K'.repeat(43);
const NO_SESSION = new ApiError(401, 'auth', 'Login required');

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.hash}`}</output>;
}

/** Opens `/setup/login#<token>` as the browser does: the address bar holds the fragment until the page takes it. */
function openLink(setup: SetupApi, signedIn: boolean, hash = `#${TOKEN}`) {
  window.history.replaceState(null, '', `/setup/login${hash}`);
  const api = fakeApi();
  if (signedIn) api.me.mockResolvedValue(me());
  else api.me.mockRejectedValueOnce(NO_SESSION).mockResolvedValue(me());
  const user = userEvent.setup();
  render(
    <ApiProvider api={api}>
      <SetupApiProvider api={setup}>
        <MemoryRouter initialEntries={[`/setup/login${hash}`]}>
          <AuthGate><p>Inside the app</p></AuthGate>
          <Where />
        </MemoryRouter>
      </SetupApiProvider>
    </ApiProvider>,
  );
  return { api, user };
}

beforeEach(() => {
  dropLinkToken();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('the login link page (/setup/login)', () => {
  it('takes the token out of the address bar at once, before the hub answers, and keeps it out of storage', () => {
    const setup = fakeSetupApi([setupState()]);
    setup.state.mockReturnValue(new Promise(() => undefined));
    openLink(setup, false);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/setup/login');
    expect(JSON.stringify({ ...window.localStorage, ...window.sessionStorage })).not.toContain(TOKEN);
  });

  it('the router keeps no fragment either', async () => {
    const setup = fakeSetupApi([setupState({ step: 'done', claimed: true })]);
    openLink(setup, false);
    await screen.findByTestId('login-link-pin');
    expect(screen.getByTestId('where').textContent).toBe('/setup/login');
  });

  it('with no PIN to type, the link is used at once on load, with no click, and goes on to the claim', async () => {
    const setup = fakeSetupApi([setupState()]);
    openLink(setup, false);
    // Unclaimed: a login link signs in but never claims; the next screen offers a passkey or the skip.
    expect(await screen.findByTestId('setup-claim-linked')).toBeTruthy();
    expect(setup.login).toHaveBeenCalledTimes(1);
    expect(setup.login).toHaveBeenCalledWith({ token: TOKEN });
    expect(window.localStorage.getItem(PAGE_KEY_STORAGE)).toBe('k'.repeat(43));
    expect(takeLinkToken()).toBeNull();
    expect(screen.getByTestId('where').textContent).not.toContain(TOKEN);
  });

  it('asks for the PIN once one is set (nothing is sent before it), and sends it with the token', async () => {
    const setup = fakeSetupApi([setupState({ step: 'done', claimed: true })]);
    setup.login.mockResolvedValue({ pageKey: PAGE_KEY });
    const { user } = openLink(setup, false);
    const field = await screen.findByTestId('login-link-pin');
    expect([field.getAttribute('autocomplete'), field.getAttribute('inputmode')]).toEqual(['one-time-code', 'numeric']);
    expect(setup.login).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('login-link-button'));
    expect(await screen.findByText('Enter your PIN: 6 to 12 digits.')).toBeTruthy();
    expect(setup.login).not.toHaveBeenCalled();
    await user.type(screen.getByTestId('login-link-pin'), '482915');
    await user.click(screen.getByTestId('login-link-button'));
    expect(setup.login).toHaveBeenCalledWith({ token: TOKEN, pin: '482915' });
    expect(window.localStorage.getItem(PAGE_KEY_STORAGE)).toBe(PAGE_KEY);
    // Claimed and done: into the app, away from the link page.
    expect(await screen.findByText('Inside the app')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/');
  });

  it('a wrong PIN says how many tries are left and keeps the link usable', async () => {
    const setup = fakeSetupApi([setupState({ step: 'done', claimed: true })]);
    setup.login.mockRejectedValueOnce(new ApiError(403, 'pin_invalid', 'Wrong PIN', { remaining: 2 }));
    const { user } = openLink(setup, false);
    await user.type(await screen.findByTestId('login-link-pin'), '000000');
    await user.click(screen.getByTestId('login-link-button'));
    expect(await screen.findByText('Wrong PIN. 2 tries left before PIN entry pauses.')).toBeTruthy();
    expect(screen.getByTestId('login-link-button')).toBeTruthy();
  });

  it('a used or expired link says to run luady login again, and offers no button that cannot work', async () => {
    const setup = fakeSetupApi([setupState()]);
    setup.login.mockRejectedValueOnce(new ApiError(401, 'auth', 'This login link expired'));
    openLink(setup, false);
    expect(await screen.findByText(/This login link has expired or was already used\. In the terminal where Luady runs, type npm run luady -- login/)).toBeTruthy();
    expect(screen.queryByTestId('login-link-button')).toBeNull();
    expect(window.localStorage.getItem(PAGE_KEY_STORAGE)).toBeNull();
  });

  it('a refusal (another machine, a proxy, a remote install) shows the hub\'s plain reason', async () => {
    const setup = fakeSetupApi([setupState()]);
    setup.login.mockRejectedValueOnce(new ApiError(403, 'forbidden', 'Login links work only on the computer Luady runs on, opened at http://localhost.'));
    openLink(setup, false);
    expect(await screen.findByText('Login links work only on the computer Luady runs on, opened at http://localhost.')).toBeTruthy();
  });

  it('when the hub did not say whether a PIN exists, it tries without one; a 428 asks for the PIN, nothing counted', async () => {
    const setup = fakeSetupApi([setupState()]);
    setup.state.mockRejectedValue(new ApiError(404, 'not_found', 'Not found'));
    setup.login.mockRejectedValueOnce(new ApiError(428, 'pin_required', 'Enter your PIN to sign in with this link')).mockResolvedValue({ pageKey: PAGE_KEY });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { user } = openLink(setup, false);
    expect(await screen.findByText('Enter your PIN to finish signing in.')).toBeTruthy();
    expect(setup.login).toHaveBeenCalledTimes(1);
    await user.type(screen.getByTestId('login-link-pin'), '482915');
    await user.click(screen.getByTestId('login-link-button'));
    expect(setup.login).toHaveBeenLastCalledWith({ token: TOKEN, pin: '482915' });
  });

  it('too many attempts says what is happening and how long to wait', async () => {
    const setup = fakeSetupApi([setupState({ step: 'done', claimed: true })]);
    setup.login.mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'Too many requests, retry in 42 seconds'));
    const { user } = openLink(setup, false);
    await user.type(await screen.findByTestId('login-link-pin'), '482915');
    await user.click(screen.getByTestId('login-link-button'));
    expect(await screen.findByText(/Too many sign-in attempts reached Luady from this computer in the last minute.*Wait 42 seconds, then try again./)).toBeTruthy();
  });

  it('opened without a token, it says where links come from', async () => {
    openLink(fakeSetupApi([setupState()]), false, '');
    expect(await screen.findByText(/This page opens from a login link\./)).toBeTruthy();
    expect(screen.queryByTestId('login-link-button')).toBeNull();
  });

  it('a fragment that is not a token is cleared too, and not kept', () => {
    const setup = fakeSetupApi([setupState()]);
    setup.state.mockReturnValue(new Promise(() => undefined));
    openLink(setup, false, '#not a token');
    expect(window.location.hash).toBe('');
    expect(takeLinkToken()).toBeNull();
  });
});
