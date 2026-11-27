import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagerSwitch, MANAGER_PLAIN_WORDS } from '../../../src/features/settings/ManagerSwitch.js';
import type { ManagerSwitchView } from '../../../src/features/settings/manager-switch-api.js';
import { settings } from '../../fixtures.js';
import { fakeApi } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';

const mocks = vi.hoisted(() => ({ view: vi.fn(), requirePinOff: vi.fn() }));
vi.mock('../../../src/features/settings/manager-switch-api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/features/settings/manager-switch-api.js')>();
  return { ...real, managerSwitchApi: { view: mocks.view, requirePinOff: mocks.requirePinOff } };
});

const steps = (state: string, detail: string | null): ManagerSwitchView['steps'] =>
  ['folders', 'brain', 'render', 'token', 'kit', 'trust'].map((id) => ({ id, state, detail }));
const OFF: ManagerSwitchView = { enabled: false, state: 'off', steps: steps('skipped', 'manager off'), signIn: false };
const STARTING: ManagerSwitchView = { enabled: true, state: 'starting', steps: steps('pending', null), signIn: false };
const ON: ManagerSwitchView = { enabled: true, state: 'on', steps: steps('done', 'up to date'), signIn: true };

beforeEach(() => {
  mocks.view.mockReset();
  mocks.requirePinOff.mockReset();
});

describe('ManagerSwitch', () => {
  it('is unticked on a new install and says in plain words what the manager may touch', async () => {
    mocks.view.mockResolvedValue(OFF);
    await renderPage(<ManagerSwitch wizard />, { api: fakeApi({ settings: async () => settings() }) });
    const box = await screen.findByRole('switch', { name: /Use the manager/ });
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(MANAGER_PLAIN_WORDS)).toBeTruthy();
    expect(MANAGER_PLAIN_WORDS).toContain('the rights of the user on each of your hosts');
    expect(MANAGER_PLAIN_WORDS).toContain('while it answers you');
    expect(MANAGER_PLAIN_WORDS).not.toContain('only in its own folder');
    expect(MANAGER_PLAIN_WORDS).toContain('strongest model, effort high');
    expect(screen.queryByRole('button', { name: /Sign the manager in/ })).toBeNull();
  });

  it('ticking it saves manager_enabled, tells onChange, and shows the set-up steps without a sign-in yet', async () => {
    mocks.view.mockResolvedValueOnce(OFF).mockResolvedValue(STARTING);
    const onChange = vi.fn();
    const api = fakeApi({ settings: async () => settings(), updateSettings: async () => settings({ manager_enabled: true }) });
    const page = await renderPage(<ManagerSwitch onChange={onChange} />, { api });
    await page.user.click(await screen.findByRole('switch', { name: /Use the manager/ }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ manager_enabled: true }));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(await screen.findByRole('list', { name: 'Setting up the manager' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sign the manager in/ })).toBeNull();
  });

  it('offers the manager\'s own Claude sign-in only once its bootstrap is done', async () => {
    mocks.view.mockResolvedValue(ON);
    await renderPage(<ManagerSwitch />, { api: fakeApi({ settings: async () => settings({ manager_enabled: true }) }) });
    expect(await screen.findByRole('button', { name: 'Sign the manager in to Claude' })).toBeTruthy();
    expect(screen.getByText('On.')).toBeTruthy();
  });

  it('a failed bootstrap shows the step that stopped it, in plain words', async () => {
    mocks.view.mockResolvedValue({ ...STARTING, state: 'failed', steps: [{ id: 'kit', state: 'failed', detail: 'cannot run python3' }] });
    await renderPage(<ManagerSwitch />, { api: fakeApi({ settings: async () => settings({ manager_enabled: true }) }) });
    expect(await screen.findByText('kit: failed (cannot run python3)')).toBeTruthy();
  });
});
