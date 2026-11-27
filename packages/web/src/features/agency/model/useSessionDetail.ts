import type { SessionDetailDTO } from '@luady/shared';
import { useCallback, useEffect, useRef } from 'react';
import { useApi } from '../../../api/context.js';
import { isApiError } from '../../../api/errors.js';
import { reportError } from '../../../lib/report.js';
import { useStore } from '../../../state/store.js';

/**
 * While a pause is asked for but has not stopped the agent yet, the detail is read again this often: the hub
 * publishes the stop itself (`pauseHit`) only in the detail, not on the socket.
 */
export const PAUSING_POLL_MS = 4_000;

/** One fetch of the detail into the store; quiet for an older hub (404) and for a view that closed meanwhile. */
function useDetailLoader(sessionId: string): () => Promise<void> {
  const api = useApi();
  const { dispatch } = useStore();
  return useCallback(async () => {
    try {
      dispatch({ type: 'detail.loaded', detail: await api.sessionActivity(sessionId) });
    } catch (err) {
      if (!isApiError(err) || err.status !== 404) reportError('agent detail', err);
    }
  }, [api, dispatch, sessionId]);
}

/**
 * Everything the agent view shows about one session: opens its slot in the store, subscribes to its steps, fetches
 * it once (again after a reconnect) and closes all of it on unmount or when the id changes.
 */
export function useSessionDetail(sessionId: string): SessionDetailDTO | null {
  const { state, dispatch, subscribeSteps } = useStore();
  const load = useDetailLoader(sessionId);
  const detail = Object.hasOwn(state.details, sessionId) ? (state.details[sessionId] ?? null) : null;
  const activity = Object.hasOwn(state.activity, sessionId) ? state.activity[sessionId] : undefined;
  const pausing = detail !== null && detail.paused && !detail.pauseHit;
  const epoch = state.connection.epoch;
  const loaded = useRef<{ readonly load: () => Promise<void>; readonly epoch: number } | null>(null);
  const seen = useRef(activity);

  useEffect(() => {
    dispatch({ type: 'detail.opened', sessionId });
    const release = subscribeSteps(sessionId);
    return () => {
      release();
      dispatch({ type: 'detail.closed', sessionId });
    };
  }, [sessionId, dispatch, subscribeSteps]);

  useEffect(() => {
    // Once per view, and again for each reconnect after it opened (steps sent while the socket was down were missed).
    const last = loaded.current;
    if (last !== null && last.load === load && (epoch <= 1 || epoch === last.epoch)) return;
    loaded.current = { load, epoch };
    void load();
  }, [load, epoch]);

  useEffect(() => {
    // While pausing: read again when its map record moves (the stop closes its steps) and every few seconds.
    if (seen.current !== activity) {
      seen.current = activity;
      if (pausing) void load();
    }
  }, [activity, pausing, load]);

  useEffect(() => {
    if (!pausing) return undefined;
    const timer = setInterval(() => void load(), PAUSING_POLL_MS);
    return () => clearInterval(timer);
  }, [pausing, load]);

  return detail;
}
