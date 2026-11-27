import { isEmptyRecap, type RecapDTO } from '@luady/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../../api/context.js';
import { isApiError } from '../../../api/errors.js';
import { reportError } from '../../../lib/report.js';
import { AWAY_MS, LAST_HERE_EVERY_MS, readLastHere, recapSince, writeLastHere } from './last-here.js';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

function deviceStore(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const visible = (): boolean => document.visibilityState !== 'hidden';

/**
 * Keeps "last here" for this device while the page is visible and touched, and asks for the recap when the owner
 * opens the office or comes back to the tab after 30 minutes or more away. `recap` is null while
 * there is nothing to show (or the hub has no recap yet).
 */
export function useWelcomeBack(store: Store | null = deviceStore()): { recap: RecapDTO | null; dismiss: () => void } {
  const api = useApi();
  const [recap, setRecap] = useState<RecapDTO | null>(null);
  const storeRef = useRef(store);
  const wroteAt = useRef(0);

  const markHere = useCallback((force: boolean) => {
    const now = Date.now();
    if (!force && now - wroteAt.current < LAST_HERE_EVERY_MS) return;
    wroteAt.current = now;
    writeLastHere(storeRef.current, now);
  }, []);

  const arrive = useCallback(() => {
    const since = recapSince(readLastHere(storeRef.current), Date.now());
    markHere(true);
    if (since === null) return;
    api.recap(new Date(since).toISOString()).then(
      (found) => setRecap(isEmptyRecap(found) ? null : found),
      (err: unknown) => {
        if (!(isApiError(err) && (err.status === 404 || err.status === 501))) reportError('recap', err);
      },
    );
  }, [api, markHere]);

  useEffect(() => {
    if (visible()) arrive();
    const onVisibility = () => {
      if (visible()) arrive();
      else markHere(true);
    };
    // A tap or key after half an hour of a visible but untouched page counts as coming back too.
    const onTouch = () => {
      if (!visible()) return;
      if (wroteAt.current > 0 && Date.now() - wroteAt.current >= AWAY_MS) arrive();
      else markHere(false);
    };
    const onLeave = () => markHere(true);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('pointerdown', onTouch, true);
    document.addEventListener('keydown', onTouch, true);
    window.addEventListener('pagehide', onLeave);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('pointerdown', onTouch, true);
      document.removeEventListener('keydown', onTouch, true);
      window.removeEventListener('pagehide', onLeave);
    };
  }, [arrive, markHere]);

  const dismiss = useCallback(() => setRecap(null), []);
  return { recap, dismiss };
}
