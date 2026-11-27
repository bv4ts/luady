import type { NoteDTO } from '@luady/shared';
import { useCallback, useMemo, useState } from 'react';
import { cardList } from '../../../../state/board.js';
import { useStore } from '../../../../state/store.js';
import { useOfficeNav } from '../../give/GiveContext.js';
import { whenText } from '../board/when.js';
import { NoteEditor } from './NoteEditor.js';
import { NoteView } from './NoteView.js';
import { useLuadyMessages, useMarkOpened, useNote, useNotesList } from './useNotes.js';
import '../board/board.css';
import './notes.css';

export interface NotesModalProps {
  /** A note to open at once (`m:…` or `n:…`). */
  readonly noteId?: string;
  readonly onClose: () => void;
}

type Pane = { readonly kind: 'list' } | { readonly kind: 'note'; readonly id: string } | { readonly kind: 'new' } | { readonly kind: 'edit'; readonly note: NoteDTO };

function NoteRow({ note, active, fresh, onOpen }: { note: NoteDTO; active: boolean; fresh: boolean; onOpen: (id: string) => void }) {
  const line = note.gist ?? note.summary;
  return (
    <li>
      <button type="button" className="notes-row" aria-current={active ? 'true' : undefined} data-new={fresh ? 'true' : undefined}
        onClick={() => onOpen(note.id)}>
        <span className="notes-row__top">
          <span className="notes-row__tags">
            <span className="notes-row__kind" data-kind={note.kind}>{note.kind === 'meeting' ? 'Meeting' : 'Note'}</span>
            {fresh ? <span className="notes-row__new" title="Not opened yet">New</span> : null}
          </span>
          <time className="notes-row__when" dateTime={note.at}>{whenText(note.at)}</time>
        </span>
        <span className="notes-row__title" dir="auto">{note.title}</span>
        {line.trim() === '' ? null : <span className="notes-row__line" dir="auto">{line}</span>}
      </button>
    </li>
  );
}

/** The open note, loaded in full; a new one is marked opened. */
function OpenNote({ id, pane, setPane }: { id: string; pane: Pane; setPane: (pane: Pane) => void }) {
  const { state } = useStore();
  const nav = useOfficeNav();
  const { note, error } = useNote(id);
  useMarkOpened(note);
  const messages = useLuadyMessages();
  const cards = useMemo(() => cardList(state.board), [state.board]);
  if (note === null) {
    return <p className={error === null ? 'notes__quiet' : 'notes__error'} role={error === null ? 'status' : 'alert'}>{error ?? 'Opening the note…'}</p>;
  }
  if (pane.kind === 'edit') {
    return <NoteEditor note={note} onSaved={(saved) => setPane({ kind: 'note', id: saved.id })} onCancel={() => setPane({ kind: 'note', id })} />;
  }
  return (
    <NoteView note={note} cards={cards} messages={messages} onEdit={() => setPane({ kind: 'edit', note })}
      onGone={() => setPane({ kind: 'list' })}
      onOpenCard={nav === null ? null : (cardId) => nav.openModal({ kind: 'board', itemId: cardId })} />
  );
}

/**
 * Notes: meeting notes from Wispr Flow and notes the owner typed, newest first with search. A note opens full
 * size beside the list (one at a time on a phone); a new note can be saved or sent to Luady straight away.
 */
export function NotesModal({ noteId }: NotesModalProps) {
  const [search, setSearch] = useState('');
  const [pane, setPane] = useState<Pane>(noteId === undefined ? { kind: 'list' } : { kind: 'note', id: noteId });
  const list = useNotesList(search);
  const openId = pane.kind === 'note' ? pane.id : pane.kind === 'edit' ? pane.note.id : null;
  // Opened here: the pill goes at once, before the hub's notes.changed reloads the list.
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set(noteId === undefined ? [] : [noteId]));
  const open = useCallback((id: string) => {
    setSeen((before) => (before.has(id) ? before : new Set([...before, id])));
    setPane({ kind: 'note', id });
  }, []);

  return (
    <div className="notes" data-testid="notes-modal" data-pane={pane.kind}>
      <aside className="notes__list" aria-label="All notes">
        <div className="notes__tools">
          <input type="search" className="notes__search" aria-label="Search notes" placeholder="Search notes and meetings" dir="auto"
            value={search} onChange={(event) => setSearch(event.target.value)} />
          <button type="button" className="notes__new" onClick={() => setPane({ kind: 'new' })}>New note</button>
        </div>
        {list.error !== null ? (
          <div className="notes__error" role="alert">
            <p>{list.error}</p>
            <button type="button" className="notes__retry" onClick={list.reload}>Try again</button>
          </div>
        ) : list.items === null ? <p className="notes__quiet" role="status">Loading notes…</p> : list.items.length === 0 ? (
          <p className="notes__quiet">{search.trim() === '' ? 'No notes yet. Paste a stand-up summary with New note, or record a meeting in Wispr Flow.' : 'No note matches that search.'}</p>
        ) : (
          <ul className="notes__rows">
            {list.items.map((note) => (
              <NoteRow key={note.id} note={note} active={note.id === openId} fresh={note.isNew === true && !seen.has(note.id)} onOpen={open} />
            ))}
          </ul>
        )}
      </aside>
      <div className="notes__page">
        {pane.kind === 'list' || pane.kind === 'new' ? null : (
          <button type="button" className="notes__back" onClick={() => setPane({ kind: 'list' })}>All notes</button>
        )}
        {pane.kind === 'new' ? (
          <NoteEditor onSaved={(saved) => { setPane({ kind: 'note', id: saved.id }); list.reload(); }} onCancel={() => setPane({ kind: 'list' })} />
        ) : openId === null ? (
          <p className="notes__quiet notes__pick">Pick a note on the left, or write a new one.</p>
        ) : <OpenNote id={openId} pane={pane} setPane={setPane} />}
      </div>
    </div>
  );
}
