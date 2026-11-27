import type { ChatMessageDTO, CreateBoardItemBody, NoteDTO } from '@luady/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { isApiError, userMessage } from '../../../../api/errors.js';
import { reportError } from '../../../../lib/report.js';
import { useStore } from '../../../../state/store.js';

/** An older hub (404) or a hub whose notes are not built yet (501). */
export const NOTES_MISSING = 'This hub has no notes yet. Update Luady to use them.';
export const SEARCH_DELAY_MS = 250;

const missing = (err: unknown): boolean => isApiError(err) && (err.status === 404 || err.status === 501);

export interface NotesList {
  readonly items: readonly NoteDTO[] | null;
  readonly error: string | null;
  reload(): void;
}

/** The notes list for a search (empty = everything), newest first; loads again on notes.changed. */
export function useNotesList(search: string): NotesList {
  const api = useApi();
  const { state } = useStore();
  const [items, setItems] = useState<readonly NoteDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState(search.trim());
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const next = search.trim();
    if (next === query) return undefined;
    const timer = setTimeout(() => setQuery(next), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search, query]);

  const version = state.notesVersion;
  useEffect(() => {
    let cancelled = false;
    api.notes(query === '' ? {} : { query }).then(
      (list) => {
        if (cancelled) return;
        setItems(list.items);
        setError(null);
      },
      (err: unknown) => {
        if (cancelled) return;
        if (!missing(err)) reportError('notes', err);
        setError(missing(err) ? NOTES_MISSING : 'The notes could not load.');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, query, version, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return useMemo(() => ({ items, error, reload }), [items, error, reload]);
}

/** One note in full (the list cuts the summary); loads again when it changes. */
export function useNote(id: string | null): { readonly note: NoteDTO | null; readonly error: string | null } {
  const api = useApi();
  const { state } = useStore();
  const [note, setNote] = useState<NoteDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const version = state.notesVersion;

  useEffect(() => {
    if (id === null) return undefined;
    let cancelled = false;
    setError(null);
    api.note(id).then(
      (next) => {
        if (!cancelled) setNote(next);
      },
      (err: unknown) => {
        if (cancelled) return;
        setNote(null);
        setError(isApiError(err) && err.status === 404 ? 'This note is gone.' : userMessage(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, id, version]);

  return { note: note?.id === id ? note : null, error };
}

/**
 * A new note that is showing gets marked opened on the hub, once per note: its "NEW" pill goes on every device and
 * the hub's notes.changed reloads the counts. A failure only leaves the pill for next time.
 */
export function useMarkOpened(note: NoteDTO | null): void {
  const api = useApi();
  const sent = useRef(new Set<string>());
  const id = note?.isNew === true ? note.id : null;
  useEffect(() => {
    if (id === null || sent.current.has(id)) return;
    sent.current.add(id);
    api.markNoteOpened(id).catch((err: unknown) => {
      sent.current.delete(id);
      if (!missing(err)) reportError('note opened', err);
    });
  }, [api, id]);
}

/** "Make it a task": one card from an action item or the whole note; the card goes into the board at once. */
export function useMakeTask(): { readonly busy: string | null; make(key: string, body: CreateBoardItemBody): Promise<void> } {
  const api = useApi();
  const { dispatch, toast } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const make = useCallback(async (key: string, body: CreateBoardItemBody) => {
    setBusy(key);
    try {
      const card = await api.createCard(body);
      dispatch({ type: 'ws.message', message: { type: 'board.updated', items: [card] } });
      toast('success', `Added #${String(card.id)}: ${card.title}`);
    } catch (err) {
      toast('error', userMessage(err));
    } finally {
      setBusy(null);
    }
  }, [api, dispatch, toast]);
  return { busy, make };
}

/** Luady's chat as far as this page knows it: the store's thread plus the newest page, fetched once for the answer. */
export function useLuadyMessages(): readonly ChatMessageDTO[] {
  const api = useApi();
  const { state } = useStore();
  const [fetched, setFetched] = useState<readonly ChatMessageDTO[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.luadyMessages(null, 50).then(
      (page) => {
        if (!cancelled) setFetched(page.items);
      },
      (err: unknown) => reportError('luady messages for notes', err),
    );
    return () => {
      cancelled = true;
    };
  }, [api]);
  return useMemo(() => {
    const byId = new Map([...fetched, ...state.luadyThread.items].map((message) => [message.id, message]));
    return [...byId.values()];
  }, [fetched, state.luadyThread.items]);
}
