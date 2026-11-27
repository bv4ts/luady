import type { ScheduleItemDTO } from '@luady/shared';
import { useCallback, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { isApiError, userMessage } from '../../../../api/errors.js';
import { useStore } from '../../../../state/store.js';
import { useLoaded } from '../library/useLoaded.js';
import { WEEKDAYS, ownerParts } from './owner-time.js';
import { nextText, sortSchedules, whenText } from './schedule-model.js';
import { ScheduleForm } from './ScheduleForm.js';
import '../../hud/kit.css';
import '../board/paper.css';
import './schedule.css';
import { managerName } from '@luady/shared';

export interface ScheduleModalProps {
  readonly onClose: () => void;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

/** The schedule board: Luady's reminders and timed jobs on a wall calendar, add and cancel. */
export function ScheduleModal(_props: ScheduleModalProps) {
  const api = useApi();
  const { state, toast } = useStore();
  const [adding, setAdding] = useState(false);
  const loaded = useLoaded(useCallback(() => api.schedules(), [api]), 'schedules', state.schedulesVersion);
  const now = Date.now();
  const today = ownerParts(now);

  return (
    <div className="cal paper-scope" data-testid="schedule-modal">
      <div className="cal__rings" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((ring) => <span key={ring} className="cal__ring" />)}</div>
      <header className="cal__head">
        <span className="cal__month agency-pixel">{MONTHS[today.month - 1]} {today.year}</span>
        <span className="cal__today">Today is {WEEKDAYS[today.weekday]} {today.day}</span>
        {adding ? null : <button type="button" className="paper-btn paper-btn--ink cal__add" onClick={() => setAdding(true)}>+ Add a reminder</button>}
      </header>
      <div className="cal__sheet">
        {adding ? (
          <ScheduleForm onDone={(item) => {
            setAdding(false);
            if (item !== null) {
              toast('success', 'On the calendar.');
              loaded.reload();
            }
          }} />
        ) : null}
        {loaded.state.kind === 'loading' ? <p className="cal__note" role="status">Turning the pages…</p> : null}
        {loaded.state.kind === 'failed' ? (
          <p className="cal__note" role="alert">
            {isApiError(loaded.state.error) && (loaded.state.error.status === 404 || loaded.state.error.status === 501)
              ? 'The schedule board needs the next hub update.' : 'The calendar could not load.'}
          </p>
        ) : null}
        {loaded.state.kind === 'ready' ? (
          loaded.state.value.items.length === 0 && !adding ? (
            <div className="cal__empty">
              <p className="cal__empty-title agency-pixel">Nothing on the calendar</p>
              <p>Add a reminder here, or ask {managerName()}: "remind me every weekday at 9 to check the deploys".</p>
            </div>
          ) : (
            <ol className="cal__list">
              {sortSchedules(loaded.state.value.items).map((item) => (
                <li key={item.id}><Entry item={item} now={now} onGone={() => {
                  toast('success', 'Cancelled.');
                  loaded.reload();
                }} /></li>
              ))}
            </ol>
          )
        ) : null}
      </div>
    </div>
  );
}

function Entry({ item, now, onGone }: { item: ScheduleItemDTO; now: number; onGone: () => void }) {
  const api = useApi();
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = item.nextRunAt === null ? null : Date.parse(item.nextRunAt);
  const day = next === null || !Number.isFinite(next) ? null : ownerParts(next);

  async function cancel() {
    setBusy(true);
    try {
      await api.cancelSchedule(item.id);
      onGone();
    } catch (err) {
      setError(isApiError(err) && err.status === 404 ? 'It was already gone.' : userMessage(err));
      setBusy(false);
      setSure(false);
    }
  }

  return (
    <article className="cal-entry" aria-label={item.task}>
      <span className={day === null ? 'cal-entry__date cal-entry__date--none' : 'cal-entry__date'} aria-hidden="true">
        <span className="cal-entry__wd">{day === null ? '—' : (WEEKDAYS[day.weekday] ?? '').slice(0, 3)}</span>
        <span className="cal-entry__num agency-pixel">{day === null ? '·' : day.day}</span>
      </span>
      <div className="cal-entry__text">
        <p className="cal-entry__task" dir="auto">{item.task}</p>
        <p className="cal-entry__when">{whenText(item.when, now)}</p>
        <p className="cal-entry__next">{nextText(item, now)}</p>
        {error === null ? null : <p className="cal-form__error" role="alert">{error}</p>}
      </div>
      <div className="cal-entry__actions">
        {sure ? (
          <span className="cal-entry__confirm" role="group" aria-label="Cancel this reminder?">
            <span>Cancel it?</span>
            <button type="button" className="paper-btn paper-btn--small" onClick={() => setSure(false)}>Keep</button>
            <button type="button" className="paper-btn paper-btn--small paper-btn--danger" disabled={busy} onClick={() => void cancel()}>Cancel it</button>
          </span>
        ) : <button type="button" className="paper-btn paper-btn--small paper-btn--danger-quiet" onClick={() => setSure(true)}>Cancel…</button>}
      </div>
    </article>
  );
}
