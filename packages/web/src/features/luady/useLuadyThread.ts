import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/context.js';
import { isApiError, userMessage } from '../../api/errors.js';
import type { LuadyThread } from '../../state/reducer.js';
import { useStore } from '../../state/store.js';
import { managerName } from '@luady/shared';

export const LUADY_PAGE = 50;

function useOlderLuadyMessages(cursor: string | null, onError: (message: string) => void) {
  const api = useApi();
  const { dispatch } = useStore();
  const [loadingOlder, setLoadingOlder] = useState(false);

  const loadOlder = useCallback(async () => {
    if (!cursor) return;
    setLoadingOlder(true);
    try {
      const page = await api.luadyMessages(cursor, LUADY_PAGE);
      dispatch({ type: 'luady.older', items: page.items, nextCursor: page.nextCursor });
    } catch (err) {
      onError(userMessage(err));
    } finally {
      setLoadingOlder(false);
    }
  }, [api, cursor, dispatch, onError]);

  return { loadingOlder, loadOlder };
}

/** What the chat says under a message the hub keeps until Luady is signed in again (the display name read now). */
export function heldText(): string {
  return `${managerName()} is signed out. Your message is kept and passed on after sign-in.`;
}

/** A send the hub refused because the manager is switched off (409 manager_off) says so in plain words. */
function sendError(err: unknown): string {
  return isApiError(err, 'manager_off') ? `${managerName()} is off. Turn it on in Settings.` : userMessage(err);
}

/**
 * Optimistic send. The hub's `manager.message` echo (or a reload) settles the pending bubble (`settlePending`).
 * `onHeld` gets the time of a send the hub kept because Luady is signed out.
 */
function useSendToLuady(onHeld: (at: string) => void) {
  const api = useApi();
  const { dispatch, toast } = useStore();
  const counter = useRef(0);

  return useCallback(async (text: string): Promise<boolean> => {
    counter.current += 1;
    const localId = `local-${counter.current}`;
    const ts = new Date().toISOString();
    dispatch({ type: 'luady.pending', localId, text, ts });
    try {
      const result = await api.sendToLuady({ text });
      dispatch({ type: 'luady.pendingSent', localId });
      if (result.held === true) onHeld(ts);
      return true;
    } catch (err) {
      dispatch({ type: 'luady.pendingFailed', localId });
      toast('error', sendError(err));
      return false;
    }
  }, [api, dispatch, toast, onHeld]);
}

/** True from a held send until Luady writes again (he is back). */
function useHeld(items: LuadyThread['items']): { held: boolean; onHeld: (at: string) => void } {
  const [heldAt, setHeldAt] = useState<string | null>(null);
  const onHeld = useCallback((at: string) => setHeldAt(at), []);
  const answered = heldAt !== null && items.some((message) => message.role === 'manager' && message.ts > heldAt);
  return { held: heldAt !== null && !answered, onHeld };
}

export function useLuadyThread() {
  const api = useApi();
  const { state, dispatch } = useStore();
  const thread = state.luadyThread;
  const [loading, setLoading] = useState(!thread.loaded);
  const [error, setError] = useState<string | null>(null);
  const seenEpoch = useRef(state.connection.epoch);

  const reload = useCallback(async () => {
    try {
      const page = await api.luadyMessages(null, LUADY_PAGE);
      dispatch({ type: 'luady.loaded', items: page.items, nextCursor: page.nextCursor });
      setError(null);
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setLoading(false);
    }
  }, [api, dispatch]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const { epoch } = state.connection;
  useEffect(() => {
    if (epoch > 1 && epoch !== seenEpoch.current) {
      seenEpoch.current = epoch;
      void reload();
    }
  }, [epoch, reload]);

  const { loadingOlder, loadOlder } = useOlderLuadyMessages(thread.nextCursor, setError);
  const { held, onHeld } = useHeld(thread.items);
  const send = useSendToLuady(onHeld);
  return { thread, loading, loadingOlder, error, loadOlder, send, held };
}
