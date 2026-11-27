import type { KbListDTO, KbPageDTO, KbPageFullDTO, LibraryDTO } from '@luady/shared';
import { useCallback, useEffect, useId, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { useStore } from '../../../../state/store.js';
import { Icon } from '../../../../ui/Icon.js';
import { MemoryBrowser } from '../../../luady/MemoryBrowser.js';
import { useRooms } from '../../../rooms/useRooms.js';
import { teamStyle } from '../../model/team-style.js';
import { libraryError } from './library-error.js';
import { officeName, officePalette, shelvesOf, spineHeight, syncLines, type Shelf } from './library-model.js';
import { PageEditor } from './PageEditor.js';
import { PageReader } from './PageReader.js';
import { useLoaded } from './useLoaded.js';
import { managerName } from '@luady/shared';

type Desk =
  | { readonly kind: 'none' }
  | { readonly kind: 'read'; readonly id: number }
  | { readonly kind: 'edit'; readonly page: KbPageFullDTO }
  | { readonly kind: 'new' };

const SEARCH_WAIT_MS = 250;

function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** The knowledge base as shelves of books, a reading desk beside them, the copy on the servers and Luady's memory. */
export function KnowledgeTab({ library }: { library: LibraryDTO | null }) {
  const api = useApi();
  const { state: store } = useStore();
  const [search, setSearch] = useState('');
  const [desk, setDesk] = useState<Desk>({ kind: 'none' });
  const query = useDebounced(search.trim(), SEARCH_WAIT_MS);
  const searchId = useId();
  const list = useLoaded(useCallback(() => api.kbPages(query === '' ? {} : { query }), [api, query]), query, store.kbVersion);
  const openId = desk.kind === 'read' ? desk.id : desk.kind === 'edit' ? desk.page.id : null;

  return (
    <div className={`lib-kb${desk.kind === 'none' ? '' : ' lib-kb--desk'}${desk.kind === 'edit' || desk.kind === 'new' ? ' lib-kb--writing' : ''}`}>
      <div className="lib-kb__stacks">
        <div className="lib-kb__bar">
          <label className="lib-search" htmlFor={searchId}>
            <span className="lib-visually-hidden">Search the pages</span>
            <input id={searchId} type="search" className="lib-input lib-search__input" placeholder="Search titles, tags and text" dir="auto"
              value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          <button type="button" className="lib-btn lib-btn--brass" onClick={() => setDesk({ kind: 'new' })}><Icon name="plus" /> New page</button>
        </div>
        {list.state.kind === 'loading' ? <p className="lib__quiet" role="status">Looking along the shelves…</p> : null}
        {list.state.kind === 'failed' ? <p className="lib__quiet" role="alert">{libraryError(list.state.error)}</p> : null}
        {list.state.kind === 'ready' ? (
          <Shelves pages={list.state.value.items} searching={query !== ''} openId={openId} onOpen={(id) => setDesk({ kind: 'read', id })} />
        ) : null}
        {list.state.kind === 'ready' ? <SyncStrip syncedAt={list.state.value.syncedAt} /> : null}
      </div>

      {desk.kind === 'none' ? null : (
        <div className="lib-kb__desk">
          {desk.kind === 'read' ? (
            <PageReader id={desk.id} onClose={() => setDesk({ kind: 'none' })} onEdit={(page) => setDesk({ kind: 'edit', page })}
              onDeleted={() => { setDesk({ kind: 'none' }); list.reload(); }} onChanged={list.reload} />
          ) : (
            <PageEditor library={library} page={desk.kind === 'edit' ? desk.page : null}
              onCancel={() => setDesk(desk.kind === 'edit' ? { kind: 'read', id: desk.page.id } : { kind: 'none' })}
              onSaved={(page) => { setDesk({ kind: 'read', id: page.id }); list.reload(); }} />
          )}
        </div>
      )}

      <section className="lib-memory" aria-label={`${managerName()}'s memory`}>
        <h3 className="lib-shelf__label">{managerName()}'s memory <span className="lib-shelf__hint">read-only, never copied to the servers</span></h3>
        <MemoryBrowser />
      </section>
    </div>
  );
}

function Shelves({ pages, searching, openId, onOpen }: {
  pages: readonly KbPageDTO[]; searching: boolean; openId: number | null; onOpen: (id: number) => void;
}) {
  const lookup = useRooms();
  if (pages.length === 0) {
    return (
      <p className="lib__quiet">
        {searching ? 'No page matches that search.' : `The shelves are empty. Add a page with what every session should know, or ask ${managerName()} to write one.`}
      </p>
    );
  }
  return (
    <div className="lib-shelves">
      {shelvesOf(pages, lookup).map((shelf) => <ShelfRow key={shelf.key} shelf={shelf} openId={openId} onOpen={onOpen} />)}
    </div>
  );
}

function ShelfRow({ shelf, openId, onOpen }: { shelf: Shelf; openId: number | null; onOpen: (id: number) => void }) {
  const lookup = useRooms();
  const style = shelf.server === null ? undefined : teamStyle(officePalette(shelf.server, lookup));
  return (
    <section className="lib-shelf" style={style} aria-label={shelf.label} data-testid={`shelf-${shelf.key}`}>
      <h3 className="lib-shelf__label" dir="auto">{shelf.label} <span className="lib-shelf__hint">{shelf.pages.length}</span></h3>
      <ul className="lib-shelf__books">
        {shelf.pages.map((page) => (
          <li key={page.id} className="lib-book-slot">
            <button type="button" className={`lib-book${page.pinned ? ' lib-book--pinned' : ''}${page.auto ? ' lib-book--auto' : ''}`}
              aria-pressed={openId === page.id} title={page.title}
              style={{ blockSize: `${String(spineHeight(page.size))}px` }} onClick={() => onOpen(page.id)}>
              <span className="lib-book__title" dir="auto">{page.title}</span>
              <span className="lib-visually-hidden">{page.pinned ? ', pinned' : ''}{page.auto ? ', built automatically' : ''}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SyncStrip({ syncedAt }: { syncedAt: KbListDTO['syncedAt'] }) {
  const api = useApi();
  const { toast } = useStore();
  const [busy, setBusy] = useState(false);
  const lookup = useRooms();
  const lines = syncLines(syncedAt, new Date(), lookup);

  async function sync() {
    setBusy(true);
    try {
      await api.syncKb();
      toast('success', 'Sending the pages to every server.');
    } catch (err) {
      toast('error', libraryError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lib-sync" aria-label="Copies on the servers">
      <span className="lib-sync__title">On the servers</span>
      {lines.length === 0 ? <span className="lib-sync__item">not copied yet</span> : lines.map((line) => (
        <span key={line.server} className="lib-sync__item">{officeName(line.server, lookup)} · {line.text}</span>
      ))}
      <button type="button" className="lib-btn lib-btn--quiet" disabled={busy} onClick={() => void sync()}>
        <Icon name="restart" /> {busy ? 'Syncing…' : 'Sync now'}
      </button>
    </div>
  );
}
