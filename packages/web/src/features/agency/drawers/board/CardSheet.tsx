import type { BoardItemDTO } from '@luady/shared';
import { useEffect, useRef, useState } from 'react';
import { questionFor } from '../../../../state/selectors.js';
import { useStore } from '../../../../state/store.js';
import { useGive, useOfficeNav, type OfficeNav } from '../../give/GiveContext.js';
import { teamStyle } from '../../model/team-style.js';
import { AskLuady } from './AskLuady.js';
import { CardFlags, CardPlace, CardText } from './CardFields.js';
import { CardDue, CardRemind } from './CardRemind.js';
import { CardLog, CardWork } from './CardWork.js';
import { useRooms } from '../../../rooms/useRooms.js';
import { cardPalette, cardsLabel, officeName, sourceLink, sourceWords, type SourceLink } from './card-words.js';
import { useCardActions, useCardDetail, type CardActions, type ProjectsByServer } from './useBoard.js';
import { whenText } from './when.js';
import { managerName } from '@luady/shared';

const STATE_WORDS: Readonly<Record<BoardItemDTO['state'], string>> = Object.freeze({
  open: 'To do', queued: `Waiting for ${managerName()}`, running: 'Running', review: 'Needs you', done: 'Done',
});

function openSource(link: SourceLink, nav: OfficeNav): void {
  if (link.kind === 'note') nav.openModal({ kind: 'notes', noteId: link.noteId });
  else if (link.kind === 'jira') nav.openModal({ kind: 'jira', room: link.room, issueKey: link.key });
  else nav.openAgent(link.sessionId);
}

function Source({ card, nav }: { card: BoardItemDTO; nav: OfficeNav | null }) {
  const link = sourceLink(card);
  const words = sourceWords(card.source);
  return (
    <p className="card-sheet__source">
      {link !== null && nav !== null ? (
        <button type="button" className="paper-link" onClick={() => openSource(link, nav)}>
          {words}{link.kind === 'jira' ? ` · ${link.key}` : ''}
        </button>
      ) : <span>{words}</span>}
      <span className="card-sheet__quiet"> · {whenText(card.createdAt)}</span>
    </p>
  );
}

function DeleteButton({ actions, onGone }: { actions: CardActions; onGone: () => void }) {
  const [sure, setSure] = useState(false);
  if (!sure) return <button type="button" className="paper-btn paper-btn--danger-quiet" onClick={() => setSure(true)}>Delete</button>;
  return (
    <span className="card-sheet__confirm" role="group" aria-label="Delete this card?">
      <span>Delete for good?</span>
      <button type="button" className="paper-btn" onClick={() => setSure(false)}>Keep</button>
      <button type="button" className="paper-btn paper-btn--danger" disabled={actions.busy}
        onClick={() => void actions.remove().then((ok) => { if (ok) onGone(); })}>Delete</button>
    </span>
  );
}

/** The buttons a card shows in its state. */
function Actions({ card, actions, nav, onClose }: { card: BoardItemDTO; actions: CardActions; nav: OfficeNav | null; onClose: () => void }) {
  const { give, openPicker } = useGive();
  const what = [{ kind: 'todo' as const, id: card.id }];
  const label = cardsLabel([card]);
  const done = () => void actions.update({ state: 'done' }, 'Marked done.');
  const reopen = () => void actions.update({ state: 'open' }, 'Back in To do.');
  const agent = card.sessionId !== null && nav !== null
    ? <button type="button" className="paper-btn paper-btn--ink" onClick={() => nav.openAgent(card.sessionId ?? '')}>Open agent</button>
    : null;
  const giveTo = <button type="button" className="paper-btn" onClick={() => openPicker(what, label)}>Give to…</button>;
  const del = <DeleteButton actions={actions} onGone={onClose} />;
  switch (card.state) {
    case 'open':
      return <>{<button type="button" className="paper-btn paper-btn--ink" onClick={() => give(what, label)}>Run</button>}{giveTo}<button type="button" className="paper-btn" onClick={done}>Mark done</button>{del}</>;
    case 'queued':
      return <><button type="button" className="paper-btn" onClick={done}>Mark done</button>{del}</>;
    case 'running':
      return <>{agent}<button type="button" className="paper-btn" onClick={done}>Mark done</button></>;
    case 'review':
      return (
        <>
          <button type="button" className="paper-btn paper-btn--ink" onClick={done}>Mark done</button>
          <button type="button" className="paper-btn" onClick={() => give(what, label)}>Run again</button>
          <button type="button" className="paper-btn" onClick={reopen}>Back to To do</button>
          {giveTo}{del}
        </>
      );
    case 'done':
      return <><button type="button" className="paper-btn" onClick={reopen}>Back to To do</button>{del}</>;
  }
}

/** A card opened: a large paper sheet over the cork with everything about it. */
export function CardSheet({ id, projects, onClose }: { id: number; projects: ProjectsByServer; onClose: () => void }) {
  const { state } = useStore();
  const lookup = useRooms();
  const nav = useOfficeNav();
  const { detail, error } = useCardDetail(id);
  const actions = useCardActions(id);
  const ref = useRef<HTMLDivElement>(null);
  const card = state.board.cards[String(id)] ?? detail?.item;
  const session = card?.sessionId == null ? undefined : state.sessions.find((s) => s.id === card.sessionId);
  const mission = card?.sessionId == null ? undefined : (state.missions[card.sessionId] ?? detail?.mission);
  const question = session === undefined ? undefined : questionFor(state.questions, session);

  useEffect(() => {
    ref.current?.focus();
  }, [id]);

  return (
    <div className="card-sheet" ref={ref} tabIndex={-1} role="region" aria-label={card === undefined ? 'Card' : `Card: ${card.title}`}
      data-testid="card-sheet"
      onPointerDown={(event) => {
        // A press on the dimmed board beside the paper closes the card, like Back does.
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}>
      <div className="card-sheet__paper" style={card === undefined ? undefined : teamStyle(cardPalette(card, lookup))}>
        <span className="paper-card__pin card-sheet__pin" aria-hidden="true" />
        <span className="paper-card__pin card-sheet__pin card-sheet__pin--right" aria-hidden="true" />
        <div className="card-sheet__bar">
          <button type="button" className="paper-btn paper-btn--small" onClick={onClose}>Back to the board</button>
          {card === undefined ? null : <span className="card-sheet__state" data-state={card.state}>#{card.id} · {STATE_WORDS[card.state]}</span>}
        </div>
        {card === undefined ? (
          <p className={error === null ? 'card-sheet__quiet' : 'paper-card__error'} role={error === null ? 'status' : 'alert'}>{error ?? 'Opening the card…'}</p>
        ) : (
          <>
            <Source card={card} nav={nav} />
            <CardText key={`${String(card.id)}:${card.updatedAt}`} card={card} actions={actions} />
            <div className="card-sheet__row">
              <CardPlace card={card} projects={projects} actions={actions} />
              <CardFlags card={card} actions={actions} />
            </div>
            {card.state === 'done' ? null : (
              <div className="card-sheet__row card-sheet__remind">
                <CardRemind card={card} actions={actions} />
                <CardDue card={card} actions={actions} />
              </div>
            )}
            <div className="card-sheet__actions"><Actions card={card} actions={actions} nav={nav} onClose={onClose} /></div>
            {card.sessionId !== null || card.result !== null || (detail?.events.length ?? 0) > 0 ? (
              <CardWork card={card} session={session} mission={mission} said={card.sessionId === null ? undefined : state.said.bySession[card.sessionId]?.said}
                question={question} events={detail?.events ?? []} onOpenAgent={nav === null ? null : nav.openAgent} />
            ) : null}
            <AskLuady about={{ kind: 'todo', id: String(card.id) }} label={`Ask ${managerName()} about this`}
              placeholder={`Ask about this card${card.server === null ? '' : ` in ${officeName(card.server, lookup) ?? ''}`}…`} />
            <CardLog events={detail?.events ?? []} />
          </>
        )}
      </div>
    </div>
  );
}
