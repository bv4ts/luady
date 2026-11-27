import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../src/api/context.js';
import { ApiError } from '../../src/api/errors.js';
import type { SetupApi } from '../../src/api/setup.js';
import { AuthGate } from '../../src/auth/AuthGate.js';
import { SetupApiProvider, useSetupState } from '../../src/features/setup/context.js';
import { CREATION_OPTIONS, me } from '../fixtures.js';
import { fakeApi, type FakeApi } from '../helpers/fake-api.js';
import { fakeSetupApi, setupState } from '../helpers/fake-setup.js';

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

const CODE = 'K7Q2-M9XA-4TPB';
const CREDENTIAL = { id: 'cred-1', rawId: 'cred-1', type: 'public-key', response: {}, clientExtensionResults: {} };
const NO_SESSION = new ApiError(401, 'auth', 'Login required');

function Home() {
  const { state } = useSetupState();
  return <p>Inside the app at {state?.step ?? 'unknown'}</p>;
}

function renderGate(api: FakeApi, setup: SetupApi | null, route = '/') {
  const user = userEvent.setup();
  const gate = <AuthGate><Home /></AuthGate>;
  render(
    <ApiProvider api={api}>
      <MemoryRouter initialEntries={[route]}>
        {setup === null ? gate : <SetupApiProvider api={setup}>{gate}</SetupApiProvider>}
      </MemoryRouter>
    </ApiProvider>,
  );
  return { user };
}

beforeEach(() => {
  webauthn.startRegistration.mockReset();
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('the gate reads the setup state first', () => {
  it('unclaimed and signed out: the claim screen, passkey recommended, with the login-link way', async () => {
    const api = fakeApi({ me: async () => { throw NO_SESSION; } });
    renderGate(api, fakeSetupApi([setupState()]));
    expect(await screen.findByTestId('setup-claim')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Claim this install' })).toBeTruthy();
    expect(screen.getByText('Recommended')).toBeTruthy();
    expect(screen.getByTestId('setup-passkey-button').textContent).toBe('Create a passkey');
    expect(screen.getByTestId('login-link-help').textContent).toMatch(/npm run luady -- login/);
    expect(screen.queryByTestId('login-passkey-button')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Setup steps' }).textContent).toMatch(/Step 1 of 6/);
  });

  it('unclaimed and remote: a passkey is required, said plainly, and no login link is offered', async () => {
    const api = fakeApi({ me: async () => { throw NO_SESSION; } });
    renderGate(api, fakeSetupApi([setupState({ remote: true })]));
    expect(await screen.findByText(/so a passkey is required before anything else/)).toBeTruthy();
    expect(screen.queryByTestId('login-link-help')).toBeNull();
  });

  it('claimed and signed out: the sign-in page with "use a login link" and no setup-code form until the hub says there is no passkey', async () => {
    const api = fakeApi({ me: async () => { throw NO_SESSION; } });
    renderGate(api, fakeSetupApi([setupState({ step: 'done', claimed: true })]));
    expect(await screen.findByTestId('login-passkey-button')).toBeTruthy();
    expect(screen.getByTestId('login-link-help')).toBeTruthy();
    expect(screen.queryByTestId('setup-code-input')).toBeNull();
    expect(screen.queryByText(/cedar|birch|ash|VPS/)).toBeNull();
  });

  it('claimed but without a passkey (a link-only owner): the sign-in page points to the login link, never to a code', async () => {
    const api = fakeApi({ me: async () => { throw NO_SESSION; }, passkeyLoginOptions: async () => { throw new ApiError(409, 'refused', 'No passkey is enrolled yet'); } });
    const { user } = renderGate(api, fakeSetupApi([setupState({ step: 'done', claimed: true })]));
    await user.click(await screen.findByTestId('login-passkey-button'));
    expect(await screen.findByText('This install has no passkey yet. Sign in with a login link (below), then add a passkey in Settings, under Security.')).toBeTruthy();
    expect(screen.queryByTestId('setup-code-input')).toBeNull();
  });

  it('claimed, remote and signed out: the sign-in page says login links are off', async () => {
    const api = fakeApi({ me: async () => { throw NO_SESSION; } });
    renderGate(api, fakeSetupApi([setupState({ step: 'done', claimed: true, remote: true })]));
    expect(await screen.findByTestId('login-link-off')).toBeTruthy();
    expect(screen.queryByTestId('login-link-help')).toBeNull();
  });

  it('an existing install (done, signed in) goes straight into the app: no wizard', async () => {
    const api = fakeApi({ me: async () => me() });
    renderGate(api, fakeSetupApi([setupState({ step: 'done', claimed: true })]));
    expect(await screen.findByText('Inside the app at done')).toBeTruthy();
    expect(screen.queryByTestId('setup-page')).toBeNull();
  });

  it('signed in at a later step: the app, which carries the state on to the wizard', async () => {
    const api = fakeApi({ me: async () => me() });
    renderGate(api, fakeSetupApi([setupState({ step: 'connect', claimed: true })]));
    expect(await screen.findByText('Inside the app at connect')).toBeTruthy();
  });

  it('without a readable state it shows sign-in with the first-passkey form', async () => {
    const api = fakeApi({ me: async () => { throw NO_SESSION; } });
    const setup = fakeSetupApi([setupState()]);
    setup.state.mockRejectedValue(new ApiError(404, 'not_found', 'Not found'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderGate(api, setup);
    expect(await screen.findByTestId('login-passkey-button')).toBeTruthy();
    expect(screen.getByTestId('setup-code-input')).toBeTruthy();
    expect(warn).toHaveBeenCalled();
  });

  it("claim with a passkey: the code is kept in memory for the PIN, which also sends this browser's zone, then the app opens", async () => {
    const options = new Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, timeZone: 'America/Chicago' });
    webauthn.startRegistration.mockResolvedValue(CREDENTIAL);
    const api = fakeApi({
      passkeyRegisterOptions: async () => CREATION_OPTIONS,
      passkeyRegisterVerify: async () => ({ ok: true, pageKey: 'q'.repeat(43) }),
      setPin: async () => ({ ok: true }),
    });
    api.me.mockRejectedValueOnce(NO_SESSION).mockResolvedValueOnce(me({ pinSet: false })).mockResolvedValue(me());
    const setup = fakeSetupApi([setupState(), setupState({ step: 'pin', claimed: true }), setupState({ step: 'rooms', claimed: true })]);
    const { user } = renderGate(api, setup);
    await user.type(await screen.findByTestId('setup-code-input'), CODE);
    await user.click(screen.getByTestId('setup-passkey-button'));
    expect(await screen.findByTestId('setup-pin')).toBeTruthy();
    expect(screen.queryByTestId('setup-code-input')).toBeNull();
    await user.type(screen.getByTestId('pin-new-input'), '135790');
    await user.type(screen.getByTestId('pin-confirm-input'), '135790');
    await user.click(screen.getByTestId('pin-save-button'));
    expect(await screen.findByText('Inside the app at rooms')).toBeTruthy();
    expect(api.setPin).toHaveBeenCalledWith({ newPin: '135790', setupCode: CODE, timeZone: 'America/Chicago' });
    expect(window.localStorage.getItem('hub.pageKey')).toBe('q'.repeat(43));
    expect(JSON.stringify(window.localStorage)).not.toContain(CODE);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('a browser that names no zone claims without one', async () => {
    const options = new Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, timeZone: '' });
    const api = fakeApi({ me: async () => me({ passkeys: 1, pinSet: false }), setPin: async () => ({ ok: true }) });
    const setup = fakeSetupApi([setupState({ step: 'pin', claimed: true }), setupState({ step: 'rooms', claimed: true })]);
    const { user } = renderGate(api, setup);
    expect(await screen.findByTestId('setup-pin')).toBeTruthy();
    await user.type(screen.getByTestId('setup-code-input'), CODE);
    await user.type(screen.getByTestId('pin-new-input'), '135790');
    await user.type(screen.getByTestId('pin-confirm-input'), '135790');
    await user.click(screen.getByTestId('pin-save-button'));
    await waitFor(() => expect(api.setPin).toHaveBeenCalledWith({ newPin: '135790', setupCode: CODE }));
  });

  it('a link session at claim: add a passkey or skip; the skip goes to the PIN step, which asks for the code', async () => {
    const api = fakeApi({ me: async () => me({ passkeys: 0, pinSet: false }) });
    const setup = fakeSetupApi([setupState(), setupState({ step: 'pin', skipped: ['passkey'] })]);
    const { user } = renderGate(api, setup);
    expect(await screen.findByTestId('setup-claim-linked')).toBeTruthy();
    expect(screen.getByTestId('setup-passkey-button').textContent).toBe('Add a passkey');
    await user.click(screen.getByTestId('setup-skip-passkey'));
    expect(setup.step).toHaveBeenCalledWith({ step: 'passkey', action: 'skip' });
    expect(await screen.findByTestId('setup-pin')).toBeTruthy();
    expect(screen.getByTestId('setup-code-input')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Setup steps' }).textContent).toMatch(/Claim \(skipped\)/);
  });

  it('a refused skip says why and keeps the passkey way open', async () => {
    const api = fakeApi({ me: async () => me({ passkeys: 0, pinSet: false }) });
    const setup = fakeSetupApi([setupState()]);
    setup.step.mockRejectedValue(new ApiError(403, 'forbidden', 'Skipping the passkey needs a login link: run npm run luady -- login in the terminal where Luady runs.'));
    const { user } = renderGate(api, setup);
    await user.click(await screen.findByTestId('setup-skip-passkey'));
    expect(await screen.findByText(/needs a login link.*You can still add a passkey above\./)).toBeTruthy();
  });
});

describe('the claim screen\'s error states', () => {
  async function claimWith(error: unknown) {
    const api = fakeApi({ me: async () => { throw NO_SESSION; }, passkeyRegisterOptions: async () => { throw error; } });
    const { user } = renderGate(api, fakeSetupApi([setupState()]));
    await user.type(await screen.findByTestId('setup-code-input'), CODE);
    await user.click(screen.getByTestId('setup-passkey-button'));
  }

  it('a wrong, used or expired code says how to get a new one', async () => {
    await claimWith(new ApiError(401, 'auth', 'Invalid setup code'));
    expect(await screen.findByText('That setup code is invalid or expired. Run npm run luady -- setup-code in the terminal where Luady runs for a new one.')).toBeTruthy();
  });

  it('an install that already has a passkey says to sign in with it', async () => {
    await claimWith(new ApiError(409, 'refused', 'exists'));
    expect(await screen.findByText('A passkey already exists. Sign in with it instead.')).toBeTruthy();
  });

  it('too many attempts says what is happening and how long to wait', async () => {
    await claimWith(new ApiError(429, 'rate_limited', 'Too many requests, retry in 1 minute'));
    expect(await screen.findByText(/Too many sign-in attempts reached Luady from this computer in the last minute. Every program on this computer shares that limit. Wait 1 minute, then try again./)).toBeTruthy();
  });

  it('a short code is caught before anything is sent', async () => {
    const api = fakeApi({ me: async () => { throw NO_SESSION; } });
    const { user } = renderGate(api, fakeSetupApi([setupState()]));
    await user.type(await screen.findByTestId('setup-code-input'), 'ABC');
    await user.click(screen.getByTestId('setup-passkey-button'));
    expect(await screen.findByText(/8 to 64 characters/)).toBeTruthy();
    expect(api.passkeyRegisterOptions).not.toHaveBeenCalled();
  });

  it('a browser without passkeys points to the login link (not remote)', async () => {
    webauthn.browserSupportsWebAuthn.mockReturnValue(false);
    const api = fakeApi({ me: async () => { throw NO_SESSION; } });
    renderGate(api, fakeSetupApi([setupState()]));
    expect(await screen.findByText("This browser can't make passkeys. Use a login link instead (below).")).toBeTruthy();
    expect((screen.getByTestId('setup-passkey-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the claim heading takes the focus, for keyboard and screen-reader users', async () => {
    const api = fakeApi({ me: async () => { throw NO_SESSION; } });
    renderGate(api, fakeSetupApi([setupState()]));
    const heading = await screen.findByRole('heading', { name: 'Claim this install' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });
});
