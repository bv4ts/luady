import { z } from 'zod';
import { DEFAULT_SETTINGS, SettingsPatchSchema, SettingsSchema, type Settings, type SettingsPatch } from '@luady/shared';
import type { Db, EventBus, SettingsService } from '../core/contracts.js';
import { ValidationError } from '../core/errors.js';

export interface SettingsDeps {
  db: Db;
  bus: EventBus;
}

interface SettingsRow {
  key: string;
  value_json: string;
}

type SettingsKey = keyof Settings;

const SETTINGS_KEYS: ReadonlySet<string> = new Set(Object.keys(SettingsSchema.shape));

function isSettingsKey(key: string): key is SettingsKey {
  return SETTINGS_KEYS.has(key);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** One JSON value per key in `settings`, merged over DEFAULT_SETTINGS. */
export function createSettingsService(deps: SettingsDeps): SettingsService {
  const selectAll = deps.db.prepare<[], SettingsRow>('SELECT key, value_json FROM settings');
  const upsert = deps.db.prepare<[string, string]>(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  );
  const persist = deps.db.transaction((entries: ReadonlyArray<readonly [string, unknown]>) => {
    for (const [key, value] of entries) upsert.run(key, JSON.stringify(value));
  });

  /** Stored values that still pass their field schema; corrupt or unknown rows are ignored. */
  function storedOverrides(): Record<string, unknown> {
    const entries = selectAll.all().flatMap((row) => {
      if (!isSettingsKey(row.key)) return [];
      const field: z.ZodType = SettingsSchema.shape[row.key];
      const parsed = field.safeParse(parseJson(row.value_json));
      return parsed.success ? [[row.key, parsed.data] as const] : [];
    });
    return Object.fromEntries(entries);
  }

  function get(): Settings {
    return SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...storedOverrides() });
  }

  function update(patch: SettingsPatch): Settings {
    const parsed = SettingsPatchSchema.safeParse(patch);
    if (!parsed.success) throw new ValidationError(`Invalid settings: ${z.prettifyError(parsed.error)}`);
    // Only settings are stored: the confirming PIN of a patch never is (web/routes/settings.ts checks it first).
    const changes = Object.entries(parsed.data).filter(([key, value]) => value !== undefined && isSettingsKey(key));
    const next = SettingsSchema.parse({ ...get(), ...Object.fromEntries(changes) });
    persist(changes);
    deps.bus.emit('settings.updated', structuredClone(next));
    return next;
  }

  return { get, update };
}
