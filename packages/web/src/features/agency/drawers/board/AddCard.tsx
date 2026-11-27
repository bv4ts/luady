import { LIMITS, isHostId, isSelfHost, type CreateBoardItemBody } from '@luady/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApi } from '../../../../api/context.js';
import { userMessage } from '../../../../api/errors.js';
import { useStore } from '../../../../state/store.js';
import { isOffice, useOfficeOptions } from '../office-options.js';

/** The body of a new card from the form; an error text when it cannot be sent. */
export function newCardBody(form: { title: string; details: string; today: boolean; high: boolean; server: string }): CreateBoardItemBody | string {
  const title = form.title.trim();
  if (title === '') return 'Give the card a title.';
  if (title.length > LIMITS.boardTitleMax) return `Keep the title under ${String(LIMITS.boardTitleMax)} characters.`;
  const details = form.details.trim();
  return {
    title, source: 'web',
    ...(details === '' ? {} : { details: details.slice(0, LIMITS.boardDetailsMax) }),
    ...(form.today ? { today: true } : {}),
    ...(form.high ? { priority: 1 as const } : {}),
    ...(isHostId(form.server) && !isSelfHost(form.server) ? { server: form.server } : {}),
  };
}

/** "+ Add" on the board: a fresh paper card at the top of To do. */
export function AddCard({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const { dispatch, toast } = useStore();
  const offices = useOfficeOptions();
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [details, setDetails] = useState('');
  const [today, setToday] = useState(false);
  const [high, setHigh] = useState(false);
  const [server, setServer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = newCardBody({ title, details, today, high, server });
    if (typeof body === 'string') {
      setError(body);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const card = await api.createCard(body);
      dispatch({ type: 'ws.message', message: { type: 'board.updated', items: [card] } });
      toast('success', `Added #${String(card.id)}: ${card.title}`);
      onDone();
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="paper-card paper-card--new" aria-label="New card" onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onDone();
        }
      }}>
      <span className="paper-card__pin" aria-hidden="true" />
      <input ref={titleRef} className="paper-input paper-input--title" aria-label="Title" placeholder="What needs doing?" dir="auto"
        maxLength={LIMITS.boardTitleMax} value={title} onChange={(event) => setTitle(event.target.value)} />
      <textarea className="paper-input" aria-label="Details" placeholder="Details (optional, Markdown)" rows={3} dir="auto"
        maxLength={LIMITS.boardDetailsMax} value={details} onChange={(event) => setDetails(event.target.value)} />
      <div className="paper-card__options">
        <select className="paper-input paper-input--small" aria-label="Office" value={server}
          onChange={(event) => setServer(isOffice(offices, event.target.value) ? event.target.value : '')}>
          <option value="">No office</option>
          {offices.map((office) => <option key={office.host} value={office.host}>{office.label}</option>)}
        </select>
        <label className="paper-check"><input type="checkbox" checked={today} onChange={(event) => setToday(event.target.checked)} /> Today</label>
        <label className="paper-check"><input type="checkbox" checked={high} onChange={(event) => setHigh(event.target.checked)} /> High priority</label>
      </div>
      {error === null ? null : <p className="paper-card__error" role="alert">{error}</p>}
      <div className="paper-card__buttons">
        <button type="button" className="paper-btn" onClick={onDone}>Cancel</button>
        <button type="submit" className="paper-btn paper-btn--ink" disabled={busy}>{busy ? 'Adding…' : 'Add card'}</button>
      </div>
    </form>
  );
}
