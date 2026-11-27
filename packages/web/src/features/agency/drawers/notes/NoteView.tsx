import type { BoardItemDTO, ChatMessageDTO, NoteDTO } from '@luady/shared';
import { useMemo, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { userMessage } from '../../../../api/errors.js';
import { Markdown } from '../../../../markdown/Markdown.js';
import { useStore } from '../../../../state/store.js';
import { AskLuady } from '../board/AskLuady.js';
import { whenText } from '../board/when.js';
import { NoteTranscript } from './NoteTranscript.js';
import { DISCUSS_TEXT, actionItemsOf, cardsFromNote, luadyAnswer, taskFromItem, taskFromNote } from './note-text.js';
import { useMakeTask } from './useNotes.js';
import { managerName } from '@luady/shared';

const STATE_WORDS: Readonly<Record<BoardItemDTO['state'], string>> = Object.freeze({
  open: 'to do', queued: `waiting for ${managerName()}`, running: 'running', review: 'needs you', done: 'done',
});

function ActionItems({ note, made }: { note: NoteDTO; made: readonly BoardItemDTO[] }) {
  const { busy, make } = useMakeTask();
  const items = actionItemsOf(note.actionItems);
  if (items.length === 0) return null;
  return (
    <section className="note-sheet__items" aria-label="Action items">
      <h4>Action items</h4>
      <ul>
        {items.map((item, index) => {
          const key = `item-${String(index)}`;
          const onBoard = made.find((card) => card.title === taskFromItem(note, item).title);
          return (
            <li key={key}>
              <span dir="auto">{item}</span>
              {onBoard === undefined ? (
                <button type="button" className="paper-btn paper-btn--small" disabled={busy !== null}
                  aria-label={`Make it a task: ${item}`} onClick={() => void make(key, taskFromItem(note, item))}>
                  {busy === key ? 'Adding…' : 'Make it a task'}
                </button>
              ) : <span className="note-sheet__on-board">On the board, {STATE_WORDS[onBoard.state]}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Answer({ messages, noteId }: { messages: readonly ChatMessageDTO[]; noteId: string }) {
  const found = useMemo(() => luadyAnswer(messages, noteId), [messages, noteId]);
  if (found === null) return null;
  return (
    <section className="note-sheet__answer" aria-label={`${managerName()}'s answer`}>
      <h4>{managerName()}'s answer</h4>
      {found.answer === null
        ? <p className="card-sheet__quiet">Sent to {managerName()} at {whenText(found.asked.ts)}. His answer shows here when it comes.</p>
        : <Markdown source={found.answer.text} className="note-sheet__luady" />}
    </section>
  );
}

function DeleteNote({ note, onGone }: { note: NoteDTO; onGone: () => void }) {
  const api = useApi();
  const { toast } = useStore();
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!sure) return <button type="button" className="paper-btn paper-btn--danger-quiet" onClick={() => setSure(true)}>Delete</button>;
  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteNote(note.id);
      toast('success', 'Note deleted.');
      onGone();
    } catch (err) {
      toast('error', userMessage(err));
      setBusy(false);
    }
  };
  return (
    <span className="card-sheet__confirm" role="group" aria-label="Delete this note?">
      <span>Delete for good?</span>
      <button type="button" className="paper-btn" onClick={() => setSure(false)}>Keep</button>
      <button type="button" className="paper-btn paper-btn--danger" disabled={busy} onClick={() => void remove()}>Delete</button>
    </span>
  );
}

export interface NoteViewProps {
  readonly note: NoteDTO;
  readonly cards: readonly BoardItemDTO[];
  readonly messages: readonly ChatMessageDTO[];
  readonly onEdit: () => void;
  readonly onGone: () => void;
  readonly onOpenCard: ((id: number) => void) | null;
}

/** A note full size: what was said, the action items as tasks, the transcript, Luady's answer and the cards. */
export function NoteView({ note, cards, messages, onEdit, onGone, onOpenCard }: NoteViewProps) {
  const { busy, make } = useMakeTask();
  const made = useMemo(() => cardsFromNote(cards, note.id), [cards, note.id]);
  return (
    <article className="note-sheet" aria-label={note.title} data-testid="note-view">
      <span className="paper-card__pin card-sheet__pin" aria-hidden="true" />
      <header className="note-sheet__head">
        <span className="note-sheet__kind" data-kind={note.kind}>{note.kind === 'meeting' ? 'Meeting' : 'Note'}</span>
        <h3 className="note-sheet__title" dir="auto">{note.title}</h3>
        <p className="card-sheet__quiet">
          {whenText(note.at)}{note.project === null ? '' : `, ${note.project}`}{note.people === null ? '' : `. With ${note.people}`}
        </p>
      </header>
      <div className="card-sheet__actions">
        <button type="button" className="paper-btn paper-btn--ink" disabled={busy !== null} onClick={() => void make('whole', taskFromNote(note))}>
          {busy === 'whole' ? 'Adding…' : 'Make it a task'}
        </button>
        {note.editable ? <button type="button" className="paper-btn" onClick={onEdit}>Edit</button> : null}
        {note.link === null || !note.link.startsWith('https://') ? null : <a className="paper-btn" href={note.link} target="_blank" rel="noreferrer noopener">Open in Wispr Flow</a>}
        {note.editable ? <DeleteNote note={note} onGone={onGone} /> : null}
      </div>
      {note.gist === null ? null : <p className="note-sheet__gist" dir="auto">{note.gist}</p>}
      {note.summary.trim() === '' ? null : <Markdown source={note.summary} className="note-sheet__summary" />}
      <ActionItems note={note} made={made} />
      {note.ownerNotes === null ? null : (
        <section className="note-sheet__own" aria-label="Your notes">
          <h4>Your notes</h4>
          <Markdown source={note.ownerNotes} />
        </section>
      )}
      {note.kind === 'meeting' && note.hasTranscript ? <NoteTranscript key={`transcript:${note.id}`} noteId={note.id} /> : null}
      <Answer messages={messages} noteId={note.id} />
      {made.length === 0 ? null : (
        <section className="note-sheet__cards" aria-label="Cards from this note">
          <h4>On the board</h4>
          <ul>
            {made.map((card) => (
              <li key={card.id}>
                {onOpenCard === null ? <span dir="auto">{card.title}</span> : (
                  <button type="button" className="paper-link" dir="auto" onClick={() => onOpenCard(card.id)}>{card.title}</button>
                )}
                <span className="card-sheet__quiet"> {STATE_WORDS[card.state]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <AskLuady key={`ask:${note.id}`} about={{ kind: 'note', id: note.id }} label={`Send to ${managerName()}`} initial={DISCUSS_TEXT}
        placeholder={`What should ${managerName()} do with this note?`} send={`Send to ${managerName()}`} />
    </article>
  );
}
