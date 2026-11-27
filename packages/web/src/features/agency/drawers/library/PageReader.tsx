import type { KbPageFullDTO } from '@luady/shared';
import { useCallback, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { Markdown } from '../../../../markdown/Markdown.js';
import { useStore } from '../../../../state/store.js';
import { Icon } from '../../../../ui/Icon.js';
import { useRooms, type RoomLookup } from '../../../rooms/useRooms.js';
import { libraryError } from './library-error.js';
import { changedLine, officeName } from './library-model.js';
import { useLoaded } from './useLoaded.js';

export interface PageReaderProps {
  readonly id: number;
  readonly onClose: () => void;
  /** Given: the reader offers Edit, Pin and Delete. */
  readonly onEdit?: (page: KbPageFullDTO) => void;
  readonly onDeleted?: () => void;
  /** After a pin change, so the shelves can show it. */
  readonly onChanged?: () => void;
}

/** Where a page applies, in words: "Everyone", "Orchard", "Orchard · orchard-web". */
export function scopeText(page: Pick<KbPageFullDTO, 'scope' | 'server' | 'project'>, lookup: RoomLookup): string {
  if (page.scope === 'global' || page.server === null) return 'Everyone';
  const name = officeName(page.server, lookup);
  return page.scope === 'office' || page.project === null ? name : `${name} · ${page.project}`;
}

/** One knowledge page open on the reading desk (Markdown through the sanitising renderer). */
export function PageReader({ id, onClose, onEdit, onDeleted, onChanged }: PageReaderProps) {
  const api = useApi();
  const { state: store, toast } = useStore();
  const lookup = useRooms();
  const { state, set } = useLoaded(useCallback(() => api.kbPage(id), [api, id]), String(id), store.kbVersion);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (state.kind === 'loading') return <p className="lib__quiet" role="status">Opening the page…</p>;
  if (state.kind === 'failed') {
    return (
      <div className="lib-reader" role="alert">
        <p>{libraryError(state.error)}</p>
        <button type="button" className="lib-btn lib-btn--quiet" onClick={onClose}>Close</button>
      </div>
    );
  }
  const page = state.value;

  async function pin() {
    setBusy(true);
    try {
      set(await api.updateKbPage(page.id, { pinned: !page.pinned }));
      onChanged?.();
    } catch (err) {
      toast('error', libraryError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteKbPage(page.id);
      toast('success', `Deleted "${page.title}".`);
      onDeleted?.();
    } catch (err) {
      toast('error', libraryError(err));
      setBusy(false);
    }
  }

  return (
    <article className="lib-reader" aria-label={page.title}>
      <header className="lib-reader__head">
        <p className="lib-reader__scope">{scopeText(page, lookup)}{page.auto ? ' · built automatically' : ''}</p>
        <h3 className="lib-reader__title" dir="auto">{page.title}</h3>
        <p className="lib-reader__meta">{changedLine(page, new Date())}</p>
        {page.tags.length === 0 ? null : (
          <p className="lib-reader__tags">{page.tags.map((tag) => <span key={tag} className="lib-chip" dir="auto">{tag}</span>)}</p>
        )}
        <div className="lib-reader__actions">
          {onEdit === undefined ? null : (
            <>
              <button type="button" className="lib-btn" disabled={busy} onClick={() => onEdit(page)}><Icon name="file" /> Edit</button>
              <button type="button" className="lib-btn" disabled={busy} aria-pressed={page.pinned} onClick={() => void pin()}>
                {page.pinned ? 'Unpin' : 'Pin'}
              </button>
              <button type="button" className="lib-btn lib-btn--danger" disabled={busy} onClick={() => setConfirming(true)}><Icon name="trash" /> Delete</button>
            </>
          )}
          <button type="button" className="lib-btn lib-btn--quiet" onClick={onClose}><Icon name="back" /> Shelves</button>
        </div>
        {confirming ? (
          <div className="lib-confirm" role="alertdialog" aria-label="Delete this page?">
            <p>Delete "{page.title}"? It also goes from the servers' copy. This cannot be undone.</p>
            <div className="lib-form__row">
              <button type="button" className="lib-btn lib-btn--danger" disabled={busy} onClick={() => void remove()}>Delete page</button>
              <button type="button" className="lib-btn lib-btn--quiet" onClick={() => setConfirming(false)}>Keep it</button>
            </div>
          </div>
        ) : null}
      </header>
      {page.body.trim() === '' ? <p className="lib__quiet">This page is empty.</p> : <Markdown source={page.body} className="lib-reader__body" />}
    </article>
  );
}
