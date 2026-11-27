import type { BoardItemDetailDTO, ProjectDTO, UpdateBoardItemBody } from '@luady/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { isApiError, userMessage } from '../../../../api/errors.js';
import { reportError } from '../../../../lib/report.js';
import { useStore } from '../../../../state/store.js';

/** An older hub (404) or a hub whose board is not built yet (501): retrying cannot help. */
export const BOARD_MISSING = 'This hub has no board yet. Update Luady to use it.';

const missing = (err: unknown): boolean => isApiError(err) && (err.status === 404 || err.status === 501);

export interface BoardLoad {
  readonly loading: boolean;
  readonly error: string | null;
  reload(): Promise<void>;
}

/**
 * Loads the board (and Luady's missions) into the store when the pop-up opens; live messages keep both fresh after that.
 * The store also loads them with the page, but quietly: here a failure is shown.
 */
export function useBoard(): BoardLoad {
  const api = useApi();
  const { dispatch } = useStore();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [board, missions] = await Promise.all([api.board(), api.missions().catch((err: unknown) => {
        if (!missing(err)) reportError('missions', err);
        return null;
      })]);
      dispatch({ type: 'board.loaded', items: board.items });
      if (missions !== null) dispatch({ type: 'missions.loaded', items: missions.items });
      setError(null);
    } catch (err) {
      if (!missing(err)) reportError('board', err);
      setError(missing(err) ? BOARD_MISSING : 'The board could not load.');
    } finally {
      setLoading(false);
    }
  }, [api, dispatch]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return useMemo(() => ({ loading, error, reload }), [loading, error, reload]);
}

export interface CardDetail {
  readonly detail: BoardItemDetailDTO | null;
  readonly error: string | null;
}

/** One card with its log and mission; fetched again whenever the card or its mission changes live. */
export function useCardDetail(id: number): CardDetail {
  const api = useApi();
  const { state } = useStore();
  const card = state.board.cards[String(id)];
  const mission = card?.sessionId == null ? undefined : state.missions[card.sessionId];
  const [detail, setDetail] = useState<BoardItemDetailDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.card(id).then(
      (next) => {
        if (cancelled) return;
        setDetail(next);
        setError(null);
      },
      (err: unknown) => {
        if (cancelled) return;
        if (!missing(err) && !(isApiError(err) && err.status === 404)) reportError('card', err);
        setError(isApiError(err) && err.status === 404 ? 'This card is gone.' : userMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, id, card, mission]);

  return { detail, error };
}

export interface CardActions {
  readonly busy: boolean;
  update(body: UpdateBoardItemBody, done?: string): Promise<boolean>;
  remove(): Promise<boolean>;
}

/** Edits and the delete of one card; the answer goes into the store at once (the live echo then changes nothing). */
export function useCardActions(id: number): CardActions {
  const api = useApi();
  const { dispatch, toast } = useStore();
  const [busy, setBusy] = useState(false);

  const update = useCallback(async (body: UpdateBoardItemBody, done?: string) => {
    setBusy(true);
    try {
      const card = await api.updateCard(id, body);
      dispatch({ type: 'ws.message', message: { type: 'board.updated', items: [card] } });
      if (done !== undefined) toast('success', done);
      return true;
    } catch (err) {
      toast('error', userMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [api, dispatch, id, toast]);

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await api.deleteCard(id);
      dispatch({ type: 'ws.message', message: { type: 'board.removed', ids: [id] } });
      toast('success', 'Card deleted.');
      return true;
    } catch (err) {
      toast('error', userMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [api, dispatch, id, toast]);

  return useMemo(() => ({ busy, update, remove }), [busy, update, remove]);
}

export type ProjectsByServer = Readonly<Partial<Record<string, readonly ProjectDTO[]>>>;

/** Every online server's project list, for the project picker (picking a project also sets its office). */
export function useAllProjects(enabled: boolean): ProjectsByServer {
  const api = useApi();
  const { state } = useStore();
  const online = state.servers.filter((server) => server.status !== 'offline').map((server) => server.name).join(',');
  const [projects, setProjects] = useState<ProjectsByServer>({});

  useEffect(() => {
    if (!enabled || online === '') return undefined;
    let cancelled = false;
    const names = online.split(',');
    void Promise.all(names.map(async (server) => {
      try {
        const list = await api.projects(server);
        return [server, list.toSorted((a, b) => a.name.localeCompare(b.name))] as const;
      } catch (err) {
        reportError(`projects ${server}`, err);
        return [server, []] as const;
      }
    })).then((entries) => {
      if (!cancelled) setProjects(Object.freeze(Object.fromEntries(entries)));
    });
    return () => {
      cancelled = true;
    };
  }, [api, enabled, online]);

  return projects;
}
