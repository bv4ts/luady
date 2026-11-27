import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../src/api/context.js';
import { ApiError } from '../../src/api/errors.js';
import { useAuth } from '../../src/auth/AuthContext.js';
import { AuthGate } from '../../src/auth/AuthGate.js';
import { SignedOutPage } from '../../src/auth/SignedOutPage.js';
import { browserZone } from '../../src/lib/browser-zone.js';
import { CREATION_OPTIONS, REQUEST_OPTIONS, me } from '../fixtures.js';
import { fakeApi, type FakeApi } from '../helpers/fake-api.js';

const webauthn = vi.hoisted(() => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  browserSupportsWebAuthn: vi.fn(() => true),
}));

vi.mock('@simplewebauthn/browser', () => ({
  ...webauthn,
  WebAuthnError: class WebAuthnError extends Error {
    readonly code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

const CREDENTIAL = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {}, clientExtensionResults: {} };
const CODE = 'K7Q2-M9XA-4TPB';
/** What the first PIN carries besides the PIN and the code: this browser's zone, when it names one. */
const withZone = (): { timeZone?: string } => {
  const zone = browserZone();
  return zone === null ? {} : { timeZone: zone };
};

function renderWith(api: FakeApi, element: ReactElement) {
  const user = userEvent.setup();
  render(<ApiProvider api={api}><MemoryRouter>{element}</MemoryRouter></ApiProvider>);
  return { user };
}

function signedOut(over: { onSignedIn?: () => Promise<void>; onRegistered?: (code: string) => Promise<void> } = {}) {
  return (
    <SignedOutPage onSignedIn={over.onSignedIn ?? vi.fn(async () => undefined)}
      onRegistered={over.onRegistered ?? vi.fn(async () => undefined)} />
  );
}

function Home() {
  const { me: owner, logout } = useAuth();
  return (
    <div>
      <p>Signed in as {owner.owner}</p>
      <button type="button" onClick={() => void logout()}>Sign out</button>
    </div>
  );
}

beforeEach(() => {
  webauthn.startAuthentication.mockReset();
  webauthn.startRegistration.mockReset();
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('signed-out screen', () => {
  it('renders the e2e test ids', () => {
    renderWith(fakeApi(), signedOut());
    expect(screen.getByTestId('login-passkey-button').tagName).toBe('BUTTON');
    expect(screen.getByTestId('setup-code-input').tagName).toBe('INPUT');
    expect(screen.getByTestId('setup-passkey-button').tagName).toBe('BUTTON');
  });

  it('names no host: the welcome is the same for every install', () => {
    renderWith(fakeApi(), signedOut());
    const text = document.body.textContent ?? '';
    expect(text).toContain('Welcome to Luady');
    for (const host of ['cedar', 'birch', 'ash', 'local']) expect(text.toLowerCase()).not.toMatch(new RegExp(`\\b${host}\\b`));
  });

  it('signs in with a passkey', async () => {
    webauthn.startAuthentication.mockResolvedValue(CREDENTIAL);
    const api = fakeApi({ passkeyLoginOptions: async () => REQUEST_OPTIONS, passkeyLoginVerify: async () => ({ ok: true, csrf: 'csrf-2' }) });
    const onSignedIn = vi.fn(async () => undefined);
    const { user } = renderWith(api, signedOut({ onSignedIn }));
    await user.click(screen.getByTestId('login-passkey-button'));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: REQUEST_OPTIONS });
    expect(api.passkeyLoginVerify).toHaveBeenCalledWith({ response: CREDENTIAL });
  });

  it('explains a cancelled passkey prompt', async () => {
    webauthn.startAuthentication.mockRejectedValue(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }));
    const api = fakeApi({ passkeyLoginOptions: async () => REQUEST_OPTIONS });
    const { user } = renderWith(api, signedOut());
    await user.click(screen.getByTestId('login-passkey-button'));
    expect(await screen.findByText('The passkey prompt was cancelled or timed out.')).toBeTruthy();
  });

  it('warns when the browser cannot use passkeys', () => {
    webauthn.browserSupportsWebAuthn.mockReturnValue(false);
    renderWith(fakeApi(), signedOut());
    expect(screen.getByText(/can't use passkeys/)).toBeTruthy();
    expect((screen.getByTestId('login-passkey-button') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('setup-passkey-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('points to first-time setup when no passkey exists yet (409)', async () => {
    const api = fakeApi({ passkeyLoginOptions: async () => { throw new ApiError(409, 'refused', 'No passkey is registered yet'); } });
    const { user } = renderWith(api, signedOut());
    await user.click(screen.getByTestId('login-passkey-button'));
    expect(await screen.findByText('No passkey is registered yet. Enter a setup code to create one: run npm run luady -- setup-code in the terminal where Luady runs.')).toBeTruthy();
  });

  it('registers the first passkey with only the setup code', async () => {
    webauthn.startRegistration.mockResolvedValue({ ...CREDENTIAL, id: 'cred-new' });
    const api = fakeApi({ passkeyRegisterOptions: async () => CREATION_OPTIONS, passkeyRegisterVerify: async () => ({ ok: true }) });
    const onRegistered = vi.fn(async () => undefined);
    const { user } = renderWith(api, signedOut({ onRegistered }));
    await user.type(screen.getByTestId('setup-code-input'), `  ${CODE} `);
    await user.click(screen.getByTestId('setup-passkey-button'));
    await waitFor(() => expect(onRegistered).toHaveBeenCalledWith(CODE));
    expect(api.passkeyRegisterOptions).toHaveBeenCalledWith({ setupCode: CODE });
    expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: CREATION_OPTIONS });
    expect(api.passkeyRegisterVerify).toHaveBeenCalledWith({ response: expect.objectContaining({ id: 'cred-new' }), label: expect.any(String) });
  });

  it('explains a rejected setup code', async () => {
    const api = fakeApi({ passkeyRegisterOptions: async () => { throw new ApiError(401, 'auth', 'Invalid setup code'); } });
    const { user } = renderWith(api, signedOut());
    await user.type(screen.getByTestId('setup-code-input'), 'OLD-CODE-1234');
    await user.click(screen.getByTestId('setup-passkey-button'));
    expect(await screen.findByText(/setup code is invalid or expired/)).toBeTruthy();
    expect(webauthn.startRegistration).not.toHaveBeenCalled();
  });
});

describe('first run through AuthGate', () => {
  it('uses the one setup code for the passkey and then the PIN, kept only in memory', async () => {
    webauthn.startRegistration.mockResolvedValue({ ...CREDENTIAL, id: 'cred-new' });
    const api = fakeApi({
      passkeyRegisterOptions: async () => CREATION_OPTIONS,
      passkeyRegisterVerify: async () => ({ ok: true }),
      setPin: async () => ({ ok: true }),
    });
    api.me
      .mockRejectedValueOnce(new ApiError(401, 'auth', 'No session'))
      .mockResolvedValueOnce(me({ pinSet: false }))
      .mockResolvedValue(me({ pinSet: true }));
    const { user } = renderWith(api, <AuthGate><Home /></AuthGate>);
    await user.type(await screen.findByTestId('setup-code-input'), CODE);
    await user.click(screen.getByTestId('setup-passkey-button'));
    await user.type(await screen.findByTestId('pin-new-input'), '135790');
    // A PIN is never offered for saving: the browser treats both fields as one-time codes.
    for (const id of ['pin-new-input', 'pin-confirm-input']) {
      expect([screen.getByTestId(id).getAttribute('autocomplete'), screen.getByTestId(id).getAttribute('inputmode')]).toEqual(['one-time-code', 'numeric']);
    }
    expect(screen.queryByTestId('setup-code-input')).toBeNull();
    await user.type(screen.getByTestId('pin-confirm-input'), '135790');
    await user.click(screen.getByTestId('pin-save-button'));
    expect(await screen.findByText('Signed in as owner@example.com')).toBeTruthy();
    expect(api.passkeyRegisterOptions).toHaveBeenCalledWith({ setupCode: CODE });
    expect(api.setPin).toHaveBeenCalledWith({ newPin: '135790', setupCode: CODE, ...withZone() });
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('asks for a new setup code when the remembered one is rejected at the PIN step', async () => {
    webauthn.startRegistration.mockResolvedValue(CREDENTIAL);
    const api = fakeApi({
      passkeyRegisterOptions: async () => CREATION_OPTIONS,
      passkeyRegisterVerify: async () => ({ ok: true }),
      setPin: async () => { throw new ApiError(401, 'auth', 'Setup code expired'); },
    });
    api.me.mockRejectedValueOnce(new ApiError(401, 'auth', 'No session')).mockResolvedValue(me({ pinSet: false }));
    const { user } = renderWith(api, <AuthGate><Home /></AuthGate>);
    await user.type(await screen.findByTestId('setup-code-input'), CODE);
    await user.click(screen.getByTestId('setup-passkey-button'));
    await user.type(await screen.findByTestId('pin-new-input'), '135790');
    await user.type(screen.getByTestId('pin-confirm-input'), '135790');
    await user.click(screen.getByTestId('pin-save-button'));
    expect(await screen.findByText(/setup code is invalid or expired/)).toBeTruthy();
    expect((screen.getByTestId('setup-code-input') as HTMLInputElement).value).toBe('');
  });

  it('shows the PIN screen to a signed-in owner without a PIN', async () => {
    const api = fakeApi({ setPin: async () => ({ ok: true }) });
    api.me.mockResolvedValueOnce(me({ pinSet: false })).mockResolvedValue(me());
    const { user } = renderWith(api, <AuthGate><Home /></AuthGate>);
    await user.type(await screen.findByTestId('setup-code-input'), CODE);
    await user.type(screen.getByTestId('pin-new-input'), '135790');
    await user.type(screen.getByTestId('pin-confirm-input'), '135791');
    await user.click(screen.getByTestId('pin-save-button'));
    expect(await screen.findByText('The two PINs do not match.')).toBeTruthy();
    await user.clear(screen.getByTestId('pin-confirm-input'));
    await user.type(screen.getByTestId('pin-confirm-input'), '135790');
    await user.click(screen.getByTestId('pin-save-button'));
    expect(await screen.findByText('Signed in as owner@example.com')).toBeTruthy();
    expect(api.setPin).toHaveBeenCalledWith({ newPin: '135790', setupCode: CODE, ...withZone() });
  });
});

describe('AuthGate', () => {
  it('renders the app for a signed-in owner and signs out', async () => {
    const api = fakeApi({ me: async () => me(), logout: async () => ({ ok: true }) });
    const { user } = renderWith(api, <AuthGate><Home /></AuthGate>);
    expect(await screen.findByText('Signed in as owner@example.com')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByTestId('login-passkey-button')).toBeTruthy();
    expect(api.logout).toHaveBeenCalledTimes(1);
  });

  it('offers a retry when the hub is unreachable', async () => {
    const api = fakeApi({ me: async () => me() });
    api.me.mockRejectedValueOnce(new ApiError(0, 'network', 'Cannot reach Luady. Check your connection and try again.'));
    const { user } = renderWith(api, <AuthGate><Home /></AuthGate>);
    expect(await screen.findByText('Cannot reach Luady. Check your connection and try again.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Signed in as owner@example.com')).toBeTruthy();
  });

  it('asks for a page reload when the Access, CSRF or Origin check fails (403 forbidden)', async () => {
    const api = fakeApi({ me: async () => { throw new ApiError(403, 'forbidden', 'Forbidden'); } });
    renderWith(api, <AuthGate><Home /></AuthGate>);
    expect(await screen.findByRole('button', { name: 'Reload page' })).toBeTruthy();
    expect(screen.getByText(/Reload the page to sign in again/)).toBeTruthy();
  });
});
