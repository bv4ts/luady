import type { BoardItemDTO } from '@luady/shared';
import { useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { userMessage } from '../../../../api/errors.js';
import { useStore } from '../../../../state/store.js';
import { cardCount } from './card-words.js';
import { backText } from './remind.js';

/**
 * The "Later" drawer under To do: snoozed cards with when each comes back, and "Bring back now". Closed it is one line
 * ("2 cards for later"); open it lists them.
 */
export function LaterDrawer({ cards, now, onOpen }: { cards: readonly BoardItemDTO[]; now: number; onOpen: (id: number) => void }) {
  const api = useApi();
  const { dispatch, toast } = useStore();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  if (cards.length === 0) return null;

  async function bringBack(card: BoardItemDTO) {
    setBusy(card.id);
    try {
      const fresh = await api.updateCard(card.id, { snoozeUntil: null });
      dispatch({ type: 'ws.message', message: { type: 'board.updated', items: [fresh] } });
      toast('success', 'Back in To do.');
    } catch (err) {
      toast('error', userMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="later">
      <button type="button" className="board-lane__foot board-lane__foot--link later__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        Later: {cardCount(cards.length)} {open ? '▴' : '▾'}
      </button>
      {open ? (
        <ul className="later__list" aria-label="Cards for later">
          {cards.map((card) => (
            <li key={card.id} className="later__card">
              <button type="button" className="later__title" dir="auto" onClick={() => onOpen(card.id)}>{card.title}</button>
              <span className="later__when">{backText(card, now)}</span>
              <button type="button" className="paper-btn paper-btn--small" disabled={busy === card.id} onClick={() => void bringBack(card)}>Bring back now</button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
