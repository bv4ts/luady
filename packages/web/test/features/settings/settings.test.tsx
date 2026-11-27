import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/api/errors.js';
import { SettingsPage } from '../../../src/features/settings/SettingsPage.js';
import { ownerDateTime } from '../../../src/lib/format.js';
import { CREATION_OPTIONS, NOW, action, passkey, settings } from '../../fixtures.js';
import { fakeApi, type FakeApi, type FakeApiOverrides } from '../../helpers/fake-api.js';
import { renderPage, type PageHarness } from '../../helpers/render.js';

const webauthn = vi.hoisted(() => ({ startRegistration: vi.fn(), startAuthentication: vi.fn(), browserSupportsWebAuthn: vi.fn(() => true) }));

vi.mock('@simplewebauthn/browser', () => ({
  ...webauthn,
  WebAuthnError: class WebAuthnError extends Error {
    readonly code = 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY';
  },
}));

const settingsApi = (over: FakeApiOverrides = {}): FakeApi => fakeApi({
  settings: async () => settings(),
  updateSettings: async (patch) => ({ ...settings(), ...patch }),
  actions: async () => [],
  passkeys: async () => ({ items: [passkey()] }),
  ...over,
});

const office = passkey({ id: 'cred-2', label: 'Office PC', createdAt: '2026-10-05T06:30:00.000Z', lastUsedAt: null });

/** Row Delete → in-page confirmation → "Delete with PIN" → PIN modal. */
async function deleteWithPin({ user }: PageHarness, name: string) {
  const list = await screen.findByRole('list', { name: 'Registered passkeys' });
  await user.click(within(list).getByRole('button', { name: `Delete passkey ${name}` }));
  expect(within(list).getByText('Delete this passkey?')).toBeTruthy();
  await user.click(within(list).getByRole('button', { name: 'Delete with PIN' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete passkey' });
  await user.type(within(dialog).getByLabelText('PIN'), '123456');
  await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
  return list;
}

beforeEach(() => {
  webauthn.startRegistration.mockReset();
});

describe('SettingsPage', () => {
  it('links to Accounts and limits in the office', async () => {
    await renderPage(<SettingsPage />, { api: settingsApi() });
    expect(screen.getByRole('link', { name: 'Accounts and limits' }).getAttribute('href')).toBe('/?open=accounts');
  });

  it('saves only the changed settings', async () => {
    const api = settingsApi();
    const { user } = await renderPage(<SettingsPage />, { api });
    const escalate = await screen.findByLabelText('Call me after (minutes)');
    await user.clear(escalate);
    await user.type(escalate, '15');
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '23:00' } });
    await user.click(screen.getByRole('switch', { name: 'Away mode' }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(api.updateSettings).toHaveBeenCalledWith({
      escalate_after_min: 15, away: true, quiet_hours: { start: '23:00', end: '08:00' },
    });
    expect(await screen.findByText('Settings saved')).toBeTruthy();
  });

  it('shows field errors instead of saving invalid values', async () => {
    const api = settingsApi();
    const { user } = await renderPage(<SettingsPage />, { api });
    const escalate = await screen.findByLabelText('Call me after (minutes)');
    await user.clear(escalate);
    await user.type(escalate, '0');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(screen.getByText('Use a whole number from 1 to 240.')).toBeTruthy();
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it('changes the PIN', async () => {
    const api = settingsApi({ setPin: async () => ({ ok: true }) });
    const { user } = await renderPage(<SettingsPage />, { api });
    for (const label of ['Current PIN', 'New PIN', 'Repeat new PIN']) {
      expect(screen.getByLabelText(label).getAttribute('autocomplete')).toBe('one-time-code');
    }
    await user.type(screen.getByLabelText('Current PIN'), '123456');
    await user.type(screen.getByLabelText('New PIN'), '654321');
    await user.type(screen.getByLabelText('Repeat new PIN'), '654320');
    await user.click(screen.getByRole('button', { name: 'Change PIN' }));
    expect(screen.getByText('The new PINs do not match.')).toBeTruthy();
    await user.clear(screen.getByLabelText('Repeat new PIN'));
    await user.type(screen.getByLabelText('Repeat new PIN'), '654321');
    await user.click(screen.getByRole('button', { name: 'Change PIN' }));
    await waitFor(() => expect(api.setPin).toHaveBeenCalledWith({ newPin: '654321', currentPin: '123456' }));
    expect(await screen.findByText('PIN changed')).toBeTruthy();
  });

  it('lists passkeys with when they were added and last used', async () => {
    const api = settingsApi({ passkeys: async () => ({ items: [passkey(), office] }) });
    await renderPage(<SettingsPage />, { api });
    const list = await screen.findByRole('list', { name: 'Registered passkeys' });
    const [phone, pc] = within(list).getAllByRole('listitem');
    expect(phone?.textContent).toContain('iPhone');
    expect(phone?.textContent).toContain(`Added ${ownerDateTime(passkey().createdAt)}`);
    expect(phone?.textContent).toContain(`last used ${ownerDateTime(NOW)}`);
    expect(pc?.textContent).toContain('Office PC');
    expect(pc?.textContent).toContain(`Added ${ownerDateTime(office.createdAt)}`);
    expect(pc?.textContent).toContain('never used');
  });

  it('adds a passkey after the PIN step-up and reloads the list', async () => {
    webauthn.startRegistration.mockResolvedValue({ id: 'cred-2', rawId: 'cred-2', type: 'public-key', response: {}, clientExtensionResults: {} });
    let items = [passkey()];
    const api = settingsApi({
      passkeys: async () => ({ items }),
      passkeyRegisterOptions: async () => CREATION_OPTIONS,
      passkeyRegisterVerify: async () => {
        items = [...items, office];
        return { ok: true };
      },
    });
    const { user, auth } = await renderPage(<SettingsPage />, { api });
    const only = await screen.findByRole('button', { name: 'Delete passkey iPhone' });
    expect((only as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Add a second passkey before you can delete this one.')).toBeTruthy();
    await user.clear(screen.getByLabelText('Name for a new passkey'));
    await user.type(screen.getByLabelText('Name for a new passkey'), 'Office PC');
    await user.click(screen.getByRole('button', { name: 'Add a passkey on this device' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a passkey' });
    await user.type(within(dialog).getByLabelText('PIN'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(auth.refreshMe).toHaveBeenCalledTimes(1));
    expect(api.passkeyRegisterOptions).toHaveBeenCalledWith({ pin: '123456' });
    expect(api.passkeyRegisterVerify).toHaveBeenCalledWith({ response: expect.objectContaining({ id: 'cred-2' }), label: 'Office PC' });
    expect(await screen.findByText('Office PC')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Delete passkey iPhone' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('deletes a passkey after an in-page confirmation and the PIN', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let items = [passkey(), office];
    const api = settingsApi({
      passkeys: async () => ({ items }),
      deletePasskey: async (id) => {
        items = items.filter((entry) => entry.id !== id);
        return { ok: true };
      },
    });
    const harness = await renderPage(<SettingsPage />, { api });
    const list = await screen.findByRole('list', { name: 'Registered passkeys' });
    await harness.user.click(within(list).getByRole('button', { name: 'Delete passkey Office PC' }));
    await harness.user.click(within(list).getByRole('button', { name: 'Keep' }));
    expect(within(list).queryByText('Delete this passkey?')).toBeNull();
    await deleteWithPin(harness, 'Office PC');
    await waitFor(() => expect(api.deletePasskey).toHaveBeenCalledWith('cred-2', { pin: '123456' }));
    await waitFor(() => expect(screen.queryByText('Office PC')).toBeNull());
    expect(harness.auth.refreshMe).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("explains a 409: the owner can't delete their only passkey", async () => {
    const api = settingsApi({
      passkeys: async () => ({ items: [passkey(), office] }),
      deletePasskey: async () => { throw new ApiError(409, 'refused', 'Cannot delete the last passkey'); },
    });
    const harness = await renderPage(<SettingsPage />, { api });
    const list = await deleteWithPin(harness, 'iPhone');
    expect(await screen.findByText("You can't delete your only passkey. Add another passkey first.")).toBeTruthy();
    expect(within(list).getByText('iPhone')).toBeTruthy();
    expect(harness.auth.refreshMe).not.toHaveBeenCalled();
  });

  it('filters the audit log by status', async () => {
    const api = settingsApi({
      actions: async (filter) => (filter?.status === 'failed'
        ? [action({ id: 'A3', status: 'failed', error: 'ssh timeout', summary: 'Run df -h on ash' })]
        : [action({ status: 'done', result: 'ok' })]),
    });
    const { user } = await renderPage(<SettingsPage />, { api });
    expect(await screen.findByText('Stop cedar · meadow-hr')).toBeTruthy();
    expect(api.actions).toHaveBeenCalledWith({ limit: 100 });
    await user.selectOptions(screen.getByLabelText('Status'), 'failed');
    expect(await screen.findByText('ssh timeout')).toBeTruthy();
    expect(api.actions).toHaveBeenLastCalledWith({ status: 'failed', limit: 100 });
  });

  it('signs out from the logout-button', async () => {
    const { user, auth } = await renderPage(<SettingsPage />, { api: settingsApi() });
    const button = screen.getByTestId('logout-button');
    expect(button).toBe(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(button);
    expect(auth.logout).toHaveBeenCalledTimes(1);
  });
});
