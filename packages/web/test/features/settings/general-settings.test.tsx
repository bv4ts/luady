import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GeneralSettings } from '../../../src/features/settings/GeneralSettings.js';
import {
  NIGHTLY_SWITCHES, generalOf, generalPatch, unsetZoneLabel, unsetZoneLine, validateGeneral, zoneOptions,
} from '../../../src/features/settings/general-settings.js';
import { settings } from '../../fixtures.js';
import { fakeApi } from '../../helpers/fake-api.js';
import { renderPage } from '../../helpers/render.js';

const mocks = vi.hoisted(() => ({ view: vi.fn(), requirePinOff: vi.fn() }));
vi.mock('../../../src/features/settings/manager-switch-api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/features/settings/manager-switch-api.js')>();
  return { ...real, managerSwitchApi: { view: mocks.view, requirePinOff: mocks.requirePinOff } };
});

beforeEach(() => {
  mocks.view.mockReset();
  mocks.view.mockResolvedValue({ enabled: false, state: 'off', steps: [], signIn: false });
  mocks.requirePinOff.mockReset();
});

describe('the General section, pure parts', () => {
  it('lists every IANA zone plus the stored one, and refuses an unknown zone or a bad name', () => {
    const zones = zoneOptions('America/New_York');
    expect(zones).toContain('Australia/Sydney');
    expect(zones).toContain('UTC');
    expect(zoneOptions('Etc/GMT-4')).toContain('Etc/GMT-4');
    expect(validateGeneral({ ...generalOf(settings()), owner_tz: 'Mars/Olympus' })).toEqual({ owner_tz: 'Pick a time zone from the list.' });
    expect(validateGeneral({ ...generalOf(settings()), manager_name: '  ' })).toEqual({ manager_name: 'Use 1 to 40 characters.' });
    expect(validateGeneral(generalOf(settings({ owner_tz: 'America/Denver' })))).toEqual({});
  });

  it("while no zone is stored, names the zone the page uses and, when the hub's differs, the hub's", () => {
    expect(unsetZoneLabel('America/Chicago')).toBe("Not set yet: using this browser's time zone");
    expect(unsetZoneLabel(null)).toBe('Not set yet (UTC)');
    expect(unsetZoneLine('America/Chicago')).toMatch(/this browser's time zone \(America\/Chicago\)\. Until you save one, the hub itself uses UTC/);
    expect(unsetZoneLine('UTC')).not.toMatch(/the hub itself/);
    expect(unsetZoneLine(null)).toMatch(/times are in UTC, on this page and on the hub/);
  });

  it('sends only what changed, never require_pin (that one needs the PIN)', () => {
    const base = generalOf(settings());
    expect(generalPatch(base, { ...base, digest_enabled: true, require_pin: false })).toEqual({ digest_enabled: true });
  });

  it('has the five nightly switches, each with one line on what it does', () => {
    expect(NIGHTLY_SWITCHES.map((job) => job.key)).toEqual(['digest_enabled', 'brief_enabled', 'claude_update_enabled', 'tools_update_enabled', 'graphify_enabled']);
    for (const job of NIGHTLY_SWITCHES) expect(job.line(settings()).split('\n')).toHaveLength(1);
    expect(NIGHTLY_SWITCHES[0]?.line(settings({ digest_time: '02:45' }))).toContain('02:45');
  });

  it('says what the tools update installs and what the code map needs', () => {
    const line = (key: string): string => NIGHTLY_SWITCHES.find((job) => job.key === key)?.line(settings()) ?? '';
    expect(line('tools_update_enabled')).toMatch(/Codex command line .*npm on this machine/);
    expect(line('graphify_enabled')).toMatch(/graphify, which each server needs installed/);
  });
});

describe('GeneralSettings', () => {
  it('shows the zone, the manager switch, its name and the five switches, all off on a new install', async () => {
    await renderPage(<GeneralSettings />, { api: fakeApi({ settings: async () => settings() }) });
    expect(await screen.findByLabelText('Your time zone')).toBeTruthy();
    expect(screen.getByLabelText("The manager's name")).toBeTruthy();
    expect(await screen.findByTestId('manager-switch')).toBeTruthy();
    for (const job of NIGHTLY_SWITCHES) {
      expect((screen.getByRole('switch', { name: job.label }) as HTMLInputElement).checked).toBe(false);
    }
  });

  it("with no zone stored, says the page uses this browser's zone and the hub UTC, and saves the zone with one button", async () => {
    const options = new Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, timeZone: 'America/Chicago' });
    const api = fakeApi({ settings: async () => settings({ owner_tz: null }), updateSettings: async (patch) => settings({ ...patch }) });
    const page = await renderPage(<GeneralSettings />, { api });
    const unset = await screen.findByTestId('zone-unset');
    expect(unset.textContent).toContain("Not set yet: this page uses this browser's time zone (America/Chicago).");
    expect(unset.textContent).toContain('the hub itself uses UTC for quiet hours, the nightly jobs, reminders and the morning brief');
    expect(screen.getByRole('option', { name: "Not set yet: using this browser's time zone" })).toBeTruthy();
    await page.user.click(screen.getByRole('button', { name: 'Save America/Chicago as my time zone' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ owner_tz: 'America/Chicago' }));
    await waitFor(() => expect(screen.queryByTestId('zone-unset')).toBeNull());
  });

  it('saves a new zone, a new name and a switch in one patch', async () => {
    const api = fakeApi({
      settings: async () => settings(),
      updateSettings: async (patch) => settings({ ...patch }),
    });
    const page = await renderPage(<GeneralSettings />, { api });
    await page.user.selectOptions(await screen.findByLabelText('Your time zone'), 'America/Denver');
    const name = screen.getByLabelText("The manager's name");
    await page.user.clear(name);
    await page.user.type(name, '  Mira ');
    await page.user.click(screen.getByRole('switch', { name: 'Code map' }));
    await page.user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ owner_tz: 'America/Denver', manager_name: 'Mira', graphify_enabled: true }));
  });

  it('turning the PIN rule off asks for the PIN, and sends it with the change', async () => {
    mocks.requirePinOff.mockResolvedValue(settings({ require_pin: false }));
    const api = fakeApi({ settings: async () => settings(), csrf: () => 'csrf-token' });
    const page = await renderPage(<GeneralSettings />, { api });
    await page.user.click(await screen.findByRole('switch', { name: /Ask for my PIN/ }));
    const pin = await screen.findByLabelText(/PIN/, { selector: 'input[type="password"], input[inputmode="numeric"]' });
    await page.user.type(pin, '135790');
    await page.user.keyboard('{Enter}');
    await waitFor(() => expect(mocks.requirePinOff).toHaveBeenCalledWith('135790', 'csrf-token'));
    expect(api.updateSettings).not.toHaveBeenCalled();
  });
});
