import { DEFAULT_WEB_PREFS, WebPrefsDTOSchema, mergeWebPrefs, type WebPrefsDTO } from '@luady/shared';
import type { Clock, Db, EventBus, Logger, PrefsService } from '../core/contracts.js';

/** Everything the preferences need (wired in app.ts). */
export interface PrefsDeps {
  /** The `settings` table, under one key of its own (the settings service ignores keys it does not know). */
  db: Db;
  /** `prefs.changed` on a change. */
  bus: EventBus;
  clock: Clock;
  log: Logger;
}

/** The one `settings` row that holds the website preferences. */
export const PREFS_KEY = 'web_prefs';

function same(a: WebPrefsDTO, b: WebPrefsDTO): boolean {
  return a.dayNight === b.dayNight && a.sound.muted === b.sound.muted && a.sound.volume === b.sound.volume;
}

/** Sound and day-and-night settings of the website, the same on every device. */
export function createPrefsService(deps: PrefsDeps): PrefsService {
  const select = deps.db.prepare<[string], { value_json: string }>('SELECT value_json FROM settings WHERE key = ?');
  const upsert = deps.db.prepare<[string, string]>(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  );

  /** What is stored over the defaults; a row that does not parse counts as the defaults. */
  function get(): WebPrefsDTO {
    const row = select.get(PREFS_KEY);
    if (row === undefined) return mergeWebPrefs(DEFAULT_WEB_PREFS, {});
    try {
      const parsed = WebPrefsDTOSchema.safeParse(JSON.parse(row.value_json));
      if (parsed.success) return mergeWebPrefs(parsed.data, {});
      deps.log.warn('prefs: stored preferences do not parse; using the defaults');
    } catch (err) {
      deps.log.warn({ err }, 'prefs: stored preferences are not JSON; using the defaults');
    }
    return mergeWebPrefs(DEFAULT_WEB_PREFS, {});
  }

  return {
    get,
    async update(patch) {
      const before = get();
      const next = WebPrefsDTOSchema.parse(mergeWebPrefs(before, patch));
      if (same(before, next)) return next;
      upsert.run(PREFS_KEY, JSON.stringify(next));
      deps.bus.emit('prefs.changed', { at: deps.clock.now().toISOString() });
      return next;
    },
  };
}
