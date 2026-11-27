import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState,
  type Dispatch, type ReactNode, type RefObject,
} from 'react';
import { isSelfHost } from '@luady/shared';
import { useApi } from '../api/context.js';
import { isApiError, userMessage } from '../api/errors.js';
import { WsClientContext, type WsClient, type WsHandlers } from '../api/ws.js';
import { reportError } from '../lib/report.js';
import { initialState, reducer, type AppAction, type AppState, type ToastKind } from './reducer.js';
import { loadOwnerSettings } from './settings-load.js';

/** Shown when the hub names another self host than this website knows: they come from two releases. */
export const VERSIONS_DIFFER = 'The hub and the website versions differ. Reload the page; if this stays, update the hub and the website together.';

export type CreateWs = (handlers: WsHandlers) => WsClient;

/** What the website tells the hub about the owner (presence and acknowledgements), straight to the socket. */
export interface LiveSignals {
  setVisible(visible: boolean): void;
  touch(): void;
  ackNotices(ids: readonly string[]): void;
}

export interface StoreValue {
  readonly state: AppState;
  readonly dispatch: Dispatch<AppAction>;
  readonly refresh: () => Promise<void>;
  readonly toast: (kind: ToastKind, text: string) => void;
  readonly subscribeTranscript: (sessionId: string) => () => void;
  readonly subscribeSteps: (sessionId: string) => () => void;
  readonly live: LiveSignals;
}

const StoreContext = createContext<StoreValue | null>(null);

/** Created during the first render so child effects can subscribe before the socket starts. */
function useLiveSocket(createWs: CreateWs, dispatch: Dispatch<AppAction>, authLost: RefObject<() => void>): WsClient {
  const [ws] = useState(() => createWs({
    onMessage: (message) => dispatch({ type: 'ws.message', message }),
    onStatus: (status, info) => dispatch({ type: 'connection.changed', status, epoch: info.epoch }),
    onWarning: (message) => reportError('live connection', new Error(message)),
    onAuthExpired: () => authLost.current(),
  }));
  useEffect(() => {
    ws.start();
    return () => ws.stop();
  }, [ws]);
  return ws;
}

/** An older hub (404) or a stub hub (501) has nothing for that slice yet: it stays empty without a word. */
const notThereYet = (err: unknown): boolean => isApiError(err) && (err.status === 404 || err.status === 501);

/**
 * The live data (activity, board, missions, speech), fetched after the overview in parallel. An older hub answers
 * 404: that slice stays empty. A 401 is a lost login like anywhere else.
 */
function useLiveLoader(
  dispatch: Dispatch<AppAction>, authLost: RefObject<() => void>, presenceVersion: RefObject<number>,
): () => Promise<void> {
  const api = useApi();
  return useCallback(async () => {
    // The hello this page just sent can change presence while the reading is on its way: the push then wins.
    const version = presenceVersion.current;
    const fail = (what: string) => (err: unknown): void => {
      if (isApiError(err) && err.status === 401) authLost.current();
      else reportError(what, err);
    };
    const quiet = (what: string) => (err: unknown): void => {
      if (!notThereYet(err)) fail(what)(err);
    };
    await Promise.all([
      api.activity().then((list) => dispatch({ type: 'activity.loaded', items: list.items }), fail('activity')),
      api.notices().then((list) => dispatch({ type: 'notices.loaded', items: list.items }), fail('notices')),
      api.presence().then((presence) => dispatch({ type: 'presence.loaded', presence, version }), fail('presence')),
      api.board().then((list) => dispatch({ type: 'board.loaded', items: list.items }), quiet('board')),
      api.missions().then((list) => dispatch({ type: 'missions.loaded', items: list.items }), quiet('missions')),
      api.said().then((list) => dispatch({ type: 'said.loaded', items: list.items }), quiet('said')),
      api.prefs().then((prefs) => dispatch({ type: 'prefs.loaded', prefs }), quiet('prefs')),
    ]);
  }, [api, dispatch, authLost, presenceVersion]);
}

/** Every `prefs.changed` reloads the preferences; an older hub or a stub hub leaves them as they are. */
function usePrefsReload(version: number, dispatch: Dispatch<AppAction>, authLost: RefObject<() => void>): void {
  const api = useApi();
  useEffect(() => {
    if (version === 0) return undefined;
    let alive = true;
    api.prefs().then(
      (prefs) => {
        if (alive) dispatch({ type: 'prefs.loaded', prefs });
      },
      (err: unknown) => {
        if (isApiError(err) && err.status === 401) authLost.current();
        else if (!notThereYet(err)) reportError('prefs', err);
      },
    );
    return () => {
      alive = false;
    };
  }, [api, version, dispatch, authLost]);
}

/**
 * After a reconnect (epoch > 1) the overview and the live data are refetched; while reconnecting the session is
 * checked (401 → auth lost).
 */
function useResync(connection: AppState['connection'], reload: () => Promise<void>, authLost: RefObject<() => void>) {
  const api = useApi();
  const { status, epoch } = connection;
  useEffect(() => {
    if (epoch > 1) void reload();
  }, [epoch, reload]);

  useEffect(() => {
    if (status !== 'reconnecting') return;
    api.me().catch((err: unknown) => {
      if (isApiError(err) && err.status === 401) authLost.current();
      else reportError('session check', err);
    });
  }, [status, api, authLost]);
}

export function StoreProvider({ createWs, onAuthLost, children }: { createWs: CreateWs; onAuthLost: () => void; children: ReactNode }) {
  const api = useApi();
  const [state, dispatch] = useReducer(reducer, initialState);
  const authLost = useRef(onAuthLost);
  useEffect(() => {
    authLost.current = onAuthLost;
  }, [onAuthLost]);

  const toast = useCallback((kind: ToastKind, text: string) => dispatch({ type: 'toast.push', kind, text }), []);

  const refresh = useCallback(async () => {
    try {
      const overview = await api.overview();
      dispatch({ type: 'overview.loaded', overview });
      if (!isSelfHost(overview.selfHost)) toast('error', VERSIONS_DIFFER);
    } catch (err) {
      if (isApiError(err) && err.status === 401) {
        authLost.current();
        return;
      }
      reportError('overview', err);
      toast('error', userMessage(err));
    }
  }, [api, toast]);

  const presenceVersion = useRef(state.presenceVersion);
  useEffect(() => {
    presenceVersion.current = state.presenceVersion;
  }, [state.presenceVersion]);
  const loadLive = useLiveLoader(dispatch, authLost, presenceVersion);
  const reload = useCallback(async () => {
    await refresh();
    await loadLive();
  }, [refresh, loadLive]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The settings load at start sets the owner's zone and the manager's name (state/settings-load.ts).
  useEffect(() => {
    void loadOwnerSettings(api);
  }, [api]);

  const ws = useLiveSocket(createWs, dispatch, authLost);
  useResync(state.connection, reload, authLost);
  usePrefsReload(state.prefsVersion, dispatch, authLost);
  const live = useMemo<LiveSignals>(() => ({ setVisible: ws.setVisible, touch: ws.touch, ackNotices: ws.ackNotices }), [ws]);

  const value = useMemo<StoreValue>(
    () => ({ state, dispatch, refresh, toast, subscribeTranscript: ws.subscribeTranscript, subscribeSteps: ws.subscribeSteps, live }),
    [state, refresh, toast, ws, live],
  );
  return <StoreContext value={value}><WsClientContext value={ws}>{children}</WsClientContext></StoreContext>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside <StoreProvider>');
  return value;
}
