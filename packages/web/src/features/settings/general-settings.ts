import { isTimeZone, type Settings } from '@luady/shared';

/** The five nightly switches: off on a new install; each says in one line what it does on your servers. */
export type NightlyKey = 'digest_enabled' | 'brief_enabled' | 'claude_update_enabled' | 'tools_update_enabled' | 'graphify_enabled';

export interface NightlySwitch {
  readonly key: NightlyKey;
  readonly label: string;
  /** One line: what runs, where, and when (the times that are settings are read from them). */
  readonly line: (settings: Pick<Settings, 'digest_time' | 'graphify_time'>) => string;
  /** Runs only while the manager is on. */
  readonly needsManager: boolean;
}

export const NIGHTLY_SWITCHES: readonly NightlySwitch[] = Object.freeze([
  { key: 'digest_enabled', label: 'Nightly summary', needsManager: true,
    line: (s) => `At ${s.digest_time} the manager reads the day's activity on your servers and writes its journal. Nothing runs on the servers.` },
  { key: 'brief_enabled', label: 'Morning brief', needsManager: true,
    line: () => 'At 08:00 the manager sends you the day: meetings, important mail, to-dos and open missions.' },
  { key: 'claude_update_enabled', label: 'Claude Code update', needsManager: false,
    line: () => 'At 04:30 every server runs `claude update`, each one once its sessions are idle.' },
  { key: 'tools_update_enabled', label: 'Tools update', needsManager: false,
    line: () => 'At 05:00 the hub installs the latest Codex command line (for images) with npm on this machine; servers are not touched.' },
  { key: 'graphify_enabled', label: 'Code map', needsManager: false,
    line: (s) => `At ${s.graphify_time} idle projects are mapped with graphify, which each server needs installed; the report goes to the manager's folder.` },
]);

/** What the General section edits. */
export type GeneralFields = Pick<Settings, 'owner_tz' | 'manager_name' | 'require_pin' | NightlyKey>;

export const GENERAL_KEYS: readonly (keyof GeneralFields)[] = Object.freeze([
  'owner_tz', 'manager_name', 'require_pin', 'digest_enabled', 'brief_enabled', 'claude_update_enabled', 'tools_update_enabled', 'graphify_enabled',
]);

export function generalOf(settings: Settings): GeneralFields {
  return Object.fromEntries(GENERAL_KEYS.map((key) => [key, settings[key]])) as GeneralFields;
}

/** Every IANA zone this browser knows, sorted, with `current` kept in the list even if the browser does not know it. */
export function zoneOptions(current: string | null): string[] {
  const known = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const all = new Set([...known, 'UTC', ...(current === null ? [] : [current])]);
  return [...all].sort((a, b) => a.localeCompare(b));
}

export { browserZone } from '../../lib/browser-zone.js';

/** The empty choice of the zone list while none is stored: what the page then shows its times in. */
export function unsetZoneLabel(browser: string | null): string {
  return browser === null ? 'Not set yet (UTC)' : "Not set yet: using this browser's time zone";
}

/**
 * The line under the zone list while none is stored. The page shows times in the browser's zone, but the hub keeps UTC
 * for its own clock (quiet hours, the nightly jobs, reminders, the morning brief) until a zone is saved: said when the two
 * differ.
 */
export function unsetZoneLine(browser: string | null): string {
  if (browser === null) return 'No time zone is set and this browser names none: times are in UTC, on this page and on the hub. Pick yours above.';
  const page = `Not set yet: this page uses this browser's time zone (${browser}).`;
  return browser === 'UTC' ? page : `${page} Until you save one, the hub itself uses UTC for quiet hours, the nightly jobs, reminders and the morning brief.`;
}

export type GeneralErrors = Partial<Record<'owner_tz' | 'manager_name', string>>;

export function validateGeneral(fields: GeneralFields): GeneralErrors {
  const name = fields.manager_name.trim();
  return {
    ...(fields.owner_tz !== null && !isTimeZone(fields.owner_tz) ? { owner_tz: 'Pick a time zone from the list.' } : {}),
    ...(name.length < 1 || name.length > 40 ? { manager_name: 'Use 1 to 40 characters.' } : {}),
  };
}

/** The changed fields only; `require_pin` is never in it (turning it off goes through the PIN, see SettingsApi). */
export function generalPatch(base: GeneralFields, next: GeneralFields): Partial<GeneralFields> {
  return Object.fromEntries(GENERAL_KEYS.filter((key) => key !== 'require_pin' && base[key] !== next[key]).map((key) => [key, next[key]]));
}
