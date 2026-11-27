import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type Loaded<T> =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'failed'; readonly error: unknown };

const LOADING = Object.freeze({ kind: 'loading' as const });

/**
 * Loads `load()` for `key` (what is shown: a page id, a ticket key, a view), again when `version` changes (a live
 * "changed" message) and on `reload()`. A new `key` shows loading at once; a new `version` keeps the last value on
 * screen until the fresh one comes. An answer for an older request, or after unmount, is dropped. `set` replaces the
 * value (an action that answered the fresh object).
 */
export function useLoaded<T>(load: () => Promise<T>, key: string, version = 0): {
  readonly state: Loaded<T>;
  readonly reload: () => void;
  readonly set: (value: T) => void;
} {
  const [stored, setStored] = useState<{ readonly key: string; readonly value: Loaded<T> }>({ key, value: LOADING });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let live = true;
    loadRef.current().then(
      (value) => { if (live) setStored({ key, value: { kind: 'ready', value } }); },
      (error: unknown) => { if (live) setStored({ key, value: { kind: 'failed', error } }); },
    );
    return () => {
      live = false;
    };
  }, [key, version, tick]);

  const state: Loaded<T> = stored.key === key ? stored.value : LOADING;
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const set = useCallback((value: T) => setStored({ key, value: { kind: 'ready', value } }), [key]);
  return useMemo(() => ({ state, reload, set }), [state, reload, set]);
}
