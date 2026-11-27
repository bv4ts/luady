import type { TranscriptItemDTO } from '@luady/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/context.js';
import { userMessage } from '../../api/errors.js';
import { useStore } from '../../state/store.js';

export const TRANSCRIPT_PAGE = 50;
const NO_ITEMS: readonly TranscriptItemDTO[] = [];

export interface TranscriptView {
  readonly items: readonly TranscriptItemDTO[];
  readonly hasOlder: boolean;
  readonly loading: boolean;
  readonly loadingOlder: boolean;
  readonly error: string | null;
  loadOlder(): Promise<void>;
}

/** Cursor paging toward older items; one request at a time. */
function useOlderTranscript(sessionId: string, cursor: string | null, onError: (message: string) => void) {
  const api = useApi();
  const { dispatch } = useStore();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const inFlight = useRef(false);

  const loadOlder = useCallback(async () => {
    if (!cursor || inFlight.current) return;
    inFlight.current = true;
    setLoadingOlder(true);
    try {
      const result = await api.transcript(sessionId, cursor, TRANSCRIPT_PAGE);
      dispatch({ type: 'transcript.older', sessionId, items: result.items, nextCursor: result.nextCursor });
    } catch (err) {
      onError(userMessage(err));
    } finally {
      inFlight.current = false;
      setLoadingOlder(false);
    }
  }, [api, cursor, dispatch, onError, sessionId]);

  return { loadingOlder, loadOlder };
}

export function useTranscript(sessionId: string): TranscriptView {
  const api = useApi();
  const { state, dispatch, subscribeTranscript } = useStore();
  const page = state.transcripts[sessionId];
  const [error, setError] = useState<string | null>(null);
  const seenEpoch = useRef(state.connection.epoch);

  const reload = useCallback(async () => {
    try {
      const result = await api.transcript(sessionId, null, TRANSCRIPT_PAGE);
      dispatch({ type: 'transcript.loaded', sessionId, items: result.items, nextCursor: result.nextCursor });
      setError(null);
    } catch (err) {
      setError(userMessage(err));
    }
  }, [api, dispatch, sessionId]);

  useEffect(() => {
    dispatch({ type: 'transcript.opened', sessionId });
    const unsubscribe = subscribeTranscript(sessionId);
    void reload();
    return () => {
      unsubscribe();
      dispatch({ type: 'transcript.closed', sessionId });
    };
  }, [dispatch, reload, sessionId, subscribeTranscript]);

  const { epoch } = state.connection;
  useEffect(() => {
    if (epoch > 1 && epoch !== seenEpoch.current) {
      seenEpoch.current = epoch;
      void reload();
    }
  }, [epoch, reload]);

  const cursor = page?.nextCursor ?? null;
  const { loadingOlder, loadOlder } = useOlderTranscript(sessionId, cursor, setError);
  return {
    items: page?.items ?? NO_ITEMS,
    hasOlder: cursor !== null,
    loading: !page?.loaded && error === null,
    loadingOlder,
    error,
    loadOlder,
  };
}
