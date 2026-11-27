import { LIMITS, type ScheduleItemDTO, managerName } from '@luady/shared';
import { useId, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { isApiError, userMessage } from '../../../../api/errors.js';
import { WEEKDAYS, dateInput } from './owner-time.js';
import { inPast, ruleToWhen, ruleWords, taskError, type Rule, type RuleKind } from './schedule-model.js';

const KINDS: readonly { kind: RuleKind; label: string }[] = [
  { kind: 'once', label: 'Once' },
  { kind: 'daily', label: 'Every day' },
  { kind: 'weekdays', label: 'Every weekday' },
  { kind: 'weekly', label: 'Every week' },
];

interface Draft {
  readonly kind: RuleKind;
  readonly date: string;
  readonly time: string;
  readonly weekday: number;
}

export function draftRule(draft: Draft): Rule {
  switch (draft.kind) {
    case 'once': return { kind: 'once', date: draft.date, time: draft.time };
    case 'daily': return { kind: 'daily', time: draft.time };
    case 'weekdays': return { kind: 'weekdays', time: draft.time };
    case 'weekly': return { kind: 'weekly', weekday: draft.weekday, time: draft.time };
  }
}

/** Add a reminder or a timed job: what Luady should do, and when (once, or a repeat), said back in words before saving. */
export function ScheduleForm({ onDone }: { onDone: (item: ScheduleItemDTO | null) => void }) {
  const api = useApi();
  const id = useId();
  const now = Date.now();
  const [task, setTask] = useState('');
  const [draft, setDraft] = useState<Draft>({ kind: 'once', date: dateInput(now + 86_400_000), time: '09:00', weekday: 4 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rule = draftRule(draft);
  const made = ruleToWhen(rule);
  const words = 'when' in made ? ruleWords(rule, now) : null;

  async function save() {
    const problem = taskError(task) ?? ('error' in made ? made.error : null) ?? (inPast(rule, Date.now()) ? 'That time has already passed.' : null);
    if (problem !== null || !('when' in made)) {
      setError(problem ?? 'Pick when.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      onDone(await api.addSchedule({ when: made.when, task: task.trim() }));
    } catch (err) {
      setError(isApiError(err) && err.status === 400 ? `${managerName()} could not read that time. Pick it again.` : userMessage(err));
      setBusy(false);
    }
  }

  return (
    <form className="cal-form agency-paper" aria-label="A new reminder" noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="cal-form__label" htmlFor={`${id}-task`}>What should {managerName()} do?</label>
      <textarea id={`${id}-task`} className="cal-input cal-input--area" dir="auto" rows={3} maxLength={LIMITS.scheduleTaskMax} value={task}
        placeholder="Remind me to send the invoices" onChange={(event) => setTask(event.target.value)} />
      <fieldset className="cal-form__when">
        <legend className="cal-form__label">When</legend>
        <div className="cal-kinds" role="radiogroup" aria-label="How often">
          {KINDS.map((option) => (
            <label key={option.kind} className={draft.kind === option.kind ? 'cal-kind cal-kind--on' : 'cal-kind'}>
              <input type="radio" name={`${id}-kind`} checked={draft.kind === option.kind} onChange={() => setDraft({ ...draft, kind: option.kind })} />
              {option.label}
            </label>
          ))}
        </div>
        <div className="cal-form__row">
          {draft.kind === 'once' ? (
            <label className="cal-field">Date
              <input type="date" className="cal-input" value={draft.date} min={dateInput(now)} onChange={(event) => setDraft({ ...draft, date: event.target.value })} />
            </label>
          ) : null}
          {draft.kind === 'weekly' ? (
            <label className="cal-field">Day
              <select className="cal-input" value={draft.weekday} onChange={(event) => setDraft({ ...draft, weekday: Number(event.target.value) })}>
                {WEEKDAYS.map((name, index) => <option key={name} value={index}>{name}</option>)}
              </select>
            </label>
          ) : null}
          <label className="cal-field">Time (owner time)
            <input type="time" className="cal-input" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} />
          </label>
        </div>
      </fieldset>
      <p className="cal-form__words" aria-live="polite">{words === null ? 'Pick when.' : words}</p>
      {error === null ? null : <p className="cal-form__error" role="alert">{error}</p>}
      <div className="cal-form__buttons">
        <button type="button" className="paper-btn" onClick={() => onDone(null)}>Cancel</button>
        <button type="submit" className="paper-btn paper-btn--ink" disabled={busy}>{busy ? 'Saving…' : 'Add to the calendar'}</button>
      </div>
    </form>
  );
}
