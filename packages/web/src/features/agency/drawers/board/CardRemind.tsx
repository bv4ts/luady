import type { BoardItemDTO } from '@luady/shared';
import { useId, useState } from 'react';
import { parseTime } from '../../../../lib/format.js';
import { dateInput, isoFromInputs, timeInput } from '../schedule/owner-time.js';
import { backText, dueState, dueText, isoAt, remindPresets } from './remind.js';
import { isSnoozed } from './lanes.js';
import type { CardActions } from './useBoard.js';

const DAY_MS = 86_400_000;

/** A date and a time in owner time, set with one press; null when the inputs are not a real moment. */
function DateTimePick({ label, initial, submit, onPick }: { label: string; initial: number; submit: string; onPick: (iso: string) => void }) {
  const id = useId();
  const [date, setDate] = useState(dateInput(initial));
  const [time, setTime] = useState(timeInput(initial));
  const [error, setError] = useState<string | null>(null);
  const pick = () => {
    const iso = isoFromInputs(date, time);
    if (iso === null) {
      setError('Pick a date and a time.');
      return;
    }
    setError(null);
    onPick(iso);
  };
  return (
    <div className="remind-pick" role="group" aria-label={label}>
      <label className="paper-field" htmlFor={`${id}-d`}><span>Date</span></label>
      <input id={`${id}-d`} type="date" className="paper-input paper-input--small" value={date} onChange={(event) => setDate(event.target.value)} />
      <label className="paper-field" htmlFor={`${id}-t`}><span>Time (owner time)</span></label>
      <input id={`${id}-t`} type="time" className="paper-input paper-input--small" value={time} onChange={(event) => setTime(event.target.value)} />
      <button type="button" className="paper-btn paper-btn--small paper-btn--ink" onClick={pick}>{submit}</button>
      {error === null ? null : <p className="paper-card__error" role="alert">{error}</p>}
    </div>
  );
}

/** "Remind me…": hides an open card from To do until a chosen time (the Later drawer lists it until then). */
export function CardRemind({ card, actions, now = Date.now() }: { card: BoardItemDTO; actions: CardActions; now?: number }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  if (card.state !== 'open') return null;
  const snooze = (at: string, label: string) => {
    setOpen(false);
    setCustom(false);
    void actions.update({ snoozeUntil: at }, `Hidden until ${label}.`);
  };

  if (isSnoozed(card, now)) {
    return (
      <div className="remind" aria-label="Reminder">
        <span className="remind__state">{backText(card, now)}</span>
        <button type="button" className="paper-btn paper-btn--small" disabled={actions.busy}
          onClick={() => void actions.update({ snoozeUntil: null }, 'Back in To do.')}>Bring back now</button>
      </div>
    );
  }
  return (
    <div className="remind" aria-label="Reminder">
      <button type="button" className="paper-btn paper-btn--small" aria-expanded={open} onClick={() => setOpen(!open)}>Remind me…</button>
      {open ? (
        <div className="remind__menu" role="menu" aria-label="Remind me">
          {remindPresets(now).map((preset) => (
            <button key={preset.id} type="button" role="menuitem" className="remind__item" disabled={actions.busy}
              onClick={() => snooze(isoAt(preset.at), preset.label)}>{preset.label}</button>
          ))}
          <button type="button" role="menuitem" className="remind__item" aria-expanded={custom} onClick={() => setCustom(!custom)}>A date and time…</button>
          {custom ? <DateTimePick label="Remind me at" initial={now + DAY_MS} submit="Remind me then" onPick={(iso) => snooze(iso, 'then')} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** The due date: a chip that turns red once it has passed, a picker to set it, and Clear. */
export function CardDue({ card, actions, now = Date.now() }: { card: BoardItemDTO; actions: CardActions; now?: number }) {
  const [editing, setEditing] = useState(false);
  const text = dueText(card, now);
  const current = parseTime(card.dueAt);
  return (
    <div className="remind" aria-label="Due date">
      {text === null ? null : <span className={`due-chip due-chip--${dueState(card, now)}`}>{text}</span>}
      {editing ? (
        <DateTimePick label="Due" initial={current ?? now + DAY_MS} submit="Set due date" onPick={(iso) => {
          setEditing(false);
          void actions.update({ dueAt: iso }, 'Due date set.');
        }} />
      ) : (
        <button type="button" className="paper-btn paper-btn--small" onClick={() => setEditing(true)}>{text === null ? 'Set a due date' : 'Change'}</button>
      )}
      {text === null || editing ? null : (
        <button type="button" className="paper-btn paper-btn--small paper-btn--danger-quiet" disabled={actions.busy}
          onClick={() => void actions.update({ dueAt: null }, 'Due date cleared.')}>Clear</button>
      )}
    </div>
  );
}
