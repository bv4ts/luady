import type { Db } from '../core/contracts.js';

/**
 * What the notices module must remember across restarts, kept as rows of the `settings` table under keys the
 * settings service does not know (it ignores them, and so does a rolled-back release).
 */
export const NOTICE_STATE_KEYS = {
  websiteFirst: 'notices.website_first',
  webTabHello: 'notices.web_tab_hello',
  forcedUntil: 'notices.forced_until',
} as const;
const KEYS = NOTICE_STATE_KEYS;

export interface NoticeState {
  /** True once any website client has said hello, ever: from then on Luady's own news follows presence. */
  websiteFirst(): boolean;
  enableWebsiteFirst(): void;
  /** The owner's latest website message came from a tab whose session said hello (so it can mark replies seen). */
  webTabHello(): boolean;
  setWebTabHello(on: boolean): void;
  /** Until when "Updates: chat" is in force (ISO time), or null. */
  forcedUntil(): string | null;
  setForcedUntil(iso: string | null): void;
}

/** A stored ISO time, or null when missing or unreadable. */
function isoOrNull(json: string | undefined): string | null {
  try {
    const value: unknown = json === undefined ? null : JSON.parse(json);
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
  } catch {
    return null;
  }
}

export function createNoticeState(db: Db): NoticeState {
  const read = db.prepare<[string], { value_json: string }>('SELECT value_json FROM settings WHERE key = ?');
  const write = db.prepare<[string, string]>(
    'INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
  );
  const flag = (key: string): boolean => read.get(key)?.value_json === 'true';
  let websiteFirst = flag(KEYS.websiteFirst);
  let webTabHello = flag(KEYS.webTabHello);
  let forcedUntil = isoOrNull(read.get(KEYS.forcedUntil)?.value_json);
  return {
    websiteFirst: () => websiteFirst,
    enableWebsiteFirst() {
      if (websiteFirst) return;
      write.run(KEYS.websiteFirst, 'true');
      websiteFirst = true;
    },
    webTabHello: () => webTabHello,
    setWebTabHello(on) {
      if (on === webTabHello) return;
      write.run(KEYS.webTabHello, on ? 'true' : 'false');
      webTabHello = on;
    },
    forcedUntil: () => forcedUntil,
    setForcedUntil(iso) {
      write.run(KEYS.forcedUntil, JSON.stringify(iso));
      forcedUntil = iso;
    },
  };
}
