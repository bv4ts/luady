import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, managerName, ownerZone, setManagerName, setOwnerZone, type Settings, type SettingsPatch } from '@luady/shared';
import { formatClock } from '../../src/features/agency/hud/Clock.js';
import { applyOwnerSettings, loadOwnerSettings, withSettingsLoad } from '../../src/state/settings-load.js';

afterEach(() => {
  setOwnerZone('Etc/GMT-4');
  setManagerName('Luady');
});

const stored = (over: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...over });

describe('the settings load sets the owner zone and the manager name', () => {
  it('at start', async () => {
    await loadOwnerSettings({ settings: async () => stored({ owner_tz: 'America/New_York', manager_name: 'Mira' }) });
    expect(ownerZone()).toBe('America/New_York');
    expect(managerName()).toBe('Mira');
  });

  it('whenever /api/settings is read, and after each save', async () => {
    const api = withSettingsLoad({
      settings: vi.fn(async () => stored({ owner_tz: 'America/New_York' })),
      updateSettings: vi.fn(async (_patch: SettingsPatch) => stored({ owner_tz: 'Australia/Sydney', manager_name: 'Mira' })),
      overview: () => 'kept',
    });
    expect(api.overview()).toBe('kept');
    await api.settings();
    expect(ownerZone()).toBe('America/New_York');
    await api.updateSettings({ owner_tz: 'Australia/Sydney' });
    expect(ownerZone()).toBe('Australia/Sydney');
    expect(managerName()).toBe('Mira');
  });

  it("while none is stored, follows this browser's own zone instead of UTC; with no browser zone either, keeps it", () => {
    applyOwnerSettings(stored({ owner_tz: null }), () => 'America/Chicago');
    expect(ownerZone()).toBe('America/Chicago');
    expect(formatClock(Date.parse('2026-01-15T18:30:00Z'))).toBe('12:30 PM');
    applyOwnerSettings(stored({ owner_tz: null }), () => null);
    expect(ownerZone()).toBe('America/Chicago');
    applyOwnerSettings(stored({ owner_tz: 'Australia/Sydney' }), () => 'America/Chicago');
    expect(ownerZone()).toBe('Australia/Sydney');
  });

  it('stays quiet when the settings cannot be read', async () => {
    await expect(loadOwnerSettings({ settings: async () => { throw new Error('offline'); } })).resolves.toBeUndefined();
    expect(ownerZone()).toBe('Etc/GMT-4');
  });
});
