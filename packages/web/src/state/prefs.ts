import { DEFAULT_WEB_PREFS, type WebPrefsDTO } from '@luady/shared';

/**
 * The website preferences as the store holds them (sound, day and night). `loaded`: GET /api/prefs answered; an older
 * hub never answers, so the defaults stay.
 */
export interface PrefsSlice {
  readonly value: WebPrefsDTO;
  readonly loaded: boolean;
}

export const EMPTY_PREFS: PrefsSlice = Object.freeze({ value: DEFAULT_WEB_PREFS, loaded: false });

const samePrefs = (a: WebPrefsDTO, b: WebPrefsDTO): boolean =>
  a.dayNight === b.dayNight && a.sound.muted === b.sound.muted && a.sound.volume === b.sound.volume;

/** `GET /api/prefs` (at start and after every `prefs.changed`): equal values keep their objects. */
export function loadPrefs(prev: PrefsSlice, value: WebPrefsDTO): PrefsSlice {
  const kept = samePrefs(prev.value, value) ? prev.value : value;
  if (kept === prev.value && prev.loaded) return prev;
  return Object.freeze({ value: kept, loaded: true });
}
