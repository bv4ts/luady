import { LIMITS, type BoardItemDTO } from '@luady/shared';
import { useCallback, useEffect, useMemo, useState, type PointerEvent } from 'react';
import { cardList } from '../../../../state/board.js';
import { questionFor } from '../../../../state/selectors.js';
import { useApi } from '../../../../api/context.js';
import { userMessage } from '../../../../api/errors.js';
import { useStore } from '../../../../state/store.js';
import { useGive, useOfficeNav } from '../../give/GiveContext.js';
import { AddCard } from './AddCard.js';
import { BoardCard, type CardLive } from './BoardCard.js';
import { CardSheet } from './CardSheet.js';
import { Lane } from './Lane.js';
import { LaterDrawer } from './LaterDrawer.js';
import { snoozedCards } from './remind.js';
import { cardCount, cardsLabel } from './card-words.js';
import { LANE_IDS, LANE_NAMES, buildLanes, canPick, ownSessionsRunning, sessionsById, type LaneId } from './lanes.js';
import { useAllProjects, useBoard } from './useBoard.js';
import './board.css';

export interface BoardModalProps {
  /** A card to open at once. */
  readonly itemId?: number;
  readonly onClose: () => void;
}

/** Ticked cards that can still be run, in the order they were ticked; at most one delegation's worth. */
export function togglePick(picked: readonly number[], id: number): readonly number[] {
  if (picked.includes(id)) return picked.filter((other) => other !== id);
  return picked.length >= LIMITS.delegateItemsMax ? picked : [...picked, id];
}

function SelectionTray({ cards, onClear }: { cards: readonly BoardItemDTO[]; onClear: () => void }) {
  const { giveTo, openPicker } = useGive();
  const [busy, setBusy] = useState(false);
  const what = cards.map((card) => ({ kind: 'todo' as const, id: card.id }));
  const label = cardsLabel(cards);
  const run = async () => {
    setBusy(true);
    const ok = await giveTo(what, label, { kind: 'auto' });
    setBusy(false);
    if (ok) onClear();
  };
  return (
    <div className="board-tray" role="toolbar" aria-label="Picked cards">
      <span className="board-tray__count">{cardCount(cards.length)} picked</span>
      <button type="button" className="paper-btn board-tray__clear" onClick={onClear}>Clear</button>
      <button type="button" className="paper-btn" onClick={() => openPicker(what, label)}>Give to…</button>
      <button type="button" className="paper-btn paper-btn--run" disabled={busy} onClick={() => void run()}>
        {busy ? 'Sending…' : `Run (${String(cards.length)})`}
      </button>
    </div>
  );
}

function LaneSwitch({ lane, counts, onLane }: { lane: LaneId; counts: Readonly<Record<LaneId, number>>; onLane: (lane: LaneId) => void }) {
  return (
    <div className="board-switch" role="group" aria-label="Lanes">
      {LANE_IDS.map((id) => (
        <button key={id} type="button" className="board-switch__lane" aria-pressed={lane === id} onClick={() => onLane(id)}>
          {LANE_NAMES[id]} <span className="board-switch__count">{counts[id]}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The owner's board: a wooden frame around cork, four lanes of paper cards, live from the store. Cards are
 * ticked for Run (n) or given to a target with the picker or a drag; pressing one opens it as a large sheet.
 */
export function BoardModal({ itemId }: BoardModalProps) {
  const { state, dispatch, toast } = useStore();
  const api = useApi();
  const load = useBoard();
  const nav = useOfficeNav();
  const { startDrag } = useGive();
  const [openId, setOpenId] = useState<number | null>(itemId ?? null);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<readonly number[]>([]);
  const [lane, setLane] = useState<LaneId>('todo');
  const projects = useAllProjects(openId !== null);
  // The page can point an open board at another card (a link from a note or a ticket).
  useEffect(() => {
    if (itemId !== undefined) setOpenId(itemId);
  }, [itemId]);

  const cards = useMemo(() => cardList(state.board), [state.board]);
  const sessions = useMemo(() => sessionsById(state.sessions), [state.sessions]);
  const lanes = useMemo(() => buildLanes(cards, sessions, Date.now()), [cards, sessions]);
  const later = useMemo(() => snoozedCards(cards, Date.now()), [cards]);
  const pickedCards = useMemo(() => picked.flatMap((id) => {
    const card = state.board.cards[String(id)];
    return card !== undefined && canPick(card) ? [card] : [];
  }), [picked, state.board.cards]);
  const others = ownSessionsRunning(state.sessions, cards);

  const liveOf = useCallback((card: BoardItemDTO): CardLive => {
    const session = card.sessionId === null ? undefined : sessions[card.sessionId];
    return {
      session,
      activity: card.sessionId === null ? undefined : state.activity[card.sessionId],
      mission: card.sessionId === null ? undefined : state.missions[card.sessionId],
      question: session === undefined ? undefined : questionFor(state.questions, session),
    };
  }, [sessions, state.activity, state.missions, state.questions]);

  const onDone = useCallback((id: number) => {
    setPicked((prev) => prev.filter((p) => p !== id));
    api.updateCard(id, { state: 'done' }).then(
      (card) => {
        dispatch({ type: 'ws.message', message: { type: 'board.updated', items: [card] } });
        toast('success', 'Marked done.');
      },
      (err: unknown) => toast('error', userMessage(err)),
    );
  }, [api, dispatch, toast]);
  const onPick = useCallback((id: number) => setPicked((prev) => togglePick(prev, id)), []);
  const onDrag = useCallback((card: BoardItemDTO, event: PointerEvent) => {
    const many = picked.includes(card.id) && pickedCards.length > 1;
    const chosen = many ? pickedCards : [card];
    startDrag(chosen.map((c) => ({ kind: 'todo' as const, id: c.id })), cardsLabel(chosen), event);
  }, [picked, pickedCards, startDrag]);

  const counts = { todo: lanes.todo.length, running: lanes.running.length, needs: lanes.needs.length, done: lanes.done.length };
  const showError = load.error !== null && !state.board.loaded;

  const renderCard = (card: BoardItemDTO, id: LaneId) => {
    const pickable = canPick(card);
    return (
      <BoardCard key={card.id} card={card} lane={id} live={liveOf(card)} onOpen={setOpenId}
        {...(pickable ? { picked: picked.includes(card.id), onPick, onDone, onDragStart: onDrag } : {})} />
    );
  };

  return (
    <div className="board" data-testid="board-modal">
      <div className="board__frame">
        <div className={pickedCards.length > 0 ? 'board__cork board__cork--tray' : 'board__cork'}>
          <LaneSwitch lane={lane} counts={counts} onLane={setLane} />
          {showError ? (
            <div className="board__notice" role="alert">
              <p>{load.error}</p>
              <button type="button" className="paper-btn" onClick={() => void load.reload()}>Try again</button>
            </div>
          ) : null}
          {load.loading && !state.board.loaded ? <p className="board__notice" role="status">Opening the board…</p> : null}
          {state.board.loaded || !load.loading ? (
            <div className="board__lanes">
              <Lane id="todo" count={counts.todo} active={lane === 'todo'} quiet={adding}
                action={<button type="button" className="board-lane__add" onClick={() => { setLane('todo'); setAdding(true); }}>+ Add</button>}
                footer={later.length > 0 ? <LaterDrawer cards={later} now={Date.now()} onOpen={setOpenId} /> : undefined}>
                {adding ? <AddCard onDone={() => setAdding(false)} /> : null}
                {lanes.todo.map((card) => renderCard(card, 'todo'))}
              </Lane>
              <Lane id="running" count={counts.running} active={lane === 'running'}
                footer={others > 0 ? (
                  <button type="button" className="board-lane__foot board-lane__foot--link" disabled={nav === null}
                    onClick={() => nav?.openModal({ kind: 'activity' })}>
                    Also running: {others === 1 ? '1 session' : `${String(others)} sessions`} you started yourself
                  </button>
                ) : undefined}>
                {lanes.running.map((card) => renderCard(card, 'running'))}
              </Lane>
              <Lane id="needs" count={counts.needs} active={lane === 'needs'}>
                {lanes.needs.map((card) => renderCard(card, 'needs'))}
              </Lane>
              <Lane id="done" count={counts.done} active={lane === 'done'}>
                {lanes.done.map((card) => renderCard(card, 'done'))}
              </Lane>
            </div>
          ) : null}
          {pickedCards.length > 0 ? <SelectionTray cards={pickedCards} onClear={() => setPicked([])} /> : null}
          {openId === null ? null : <CardSheet id={openId} projects={projects} onClose={() => setOpenId(null)} />}
        </div>
      </div>
    </div>
  );
}
