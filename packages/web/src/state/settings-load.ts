import { setManagerName, setOwnerZone, type Settings, type SettingsPatch } from '@luady/shared';
import { browserZone } from '../lib/browser-zone.js';

/**
 * The settings load: every time the website reads `/api/settings` (at start, and after each
 * save) it sets the owner's zone and the manager's name, so every owner time and every "the manager" text follows them.
 */
export function applyOwnerSettings(settings: Pick<Settings, 'owner_tz' | 'manager_name'>, browser: () => string | null = browserZone): void {
  // No zone stored yet: the page shows times in this browser's own zone rather than UTC (Settings offers to save it).
  const zone = settings.owner_tz ?? browser();
  if (zone !== null) setOwnerZone(zone);
  setManagerName(settings.manager_name);
}

interface SettingsApi {
  settings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
}

/** The same API, with the settings load on both settings routes. */
export function withSettingsLoad<A extends SettingsApi>(api: A): A {
  return {
    ...api,
    settings: async () => {
      const settings = await api.settings();
      applyOwnerSettings(settings);
      return settings;
    },
    updateSettings: async (patch: SettingsPatch) => {
      const settings = await api.updateSettings(patch);
      applyOwnerSettings(settings);
      return settings;
    },
  };
}

/**
 * The load at start. A failure leaves the zone and the name as they are, quietly: the page works without them, and the
 * Settings page shows its own error when it cannot read the settings.
 */
export async function loadOwnerSettings(api: Pick<SettingsApi, 'settings'>): Promise<void> {
  try {
    applyOwnerSettings(await api.settings());
  } catch {
    // Kept as they were.
  }
}
