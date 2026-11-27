import { useEffect, useState } from 'react';
import { useStore } from '../../../state/store.js';
import { activityCounts, activityRows, helperWords, pillWords, turnWords, type ActivityRow } from '../model/activity-list.js';
import { teamStyle } from '../model/team-style.js';
import './activity.css';
import { managerName } from '@luady/shared';

export interface ActivityModalProps {
  readonly onClose: () => void;
  /** Opens that agent. */
  readonly onSelect: (id: string) => void;
}

const TICK_MS = 30_000;

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Row({ row, now, onSelect }: { row: ActivityRow; now: number; onSelect: (id: string) => void }) {
  const turn = turnWords(row.startedAt, now);
  const helpers = helperWords(row);
  return (
    <li>
      <button type="button" className="activity-row" style={teamStyle(row.palette)} onClick={() => onSelect(row.id)}
        aria-label={`${row.name} in ${row.room}${row.step === null ? '' : `: ${row.step}`}. Open the agent`}>
        <span className="activity-row__pulse" aria-hidden="true" />
        <span className="activity-row__main">
          <span className="activity-row__top">
            <span className="activity-row__name" dir="auto">{row.name}</span>
            <span className="agency-tag activity-row__room">{row.room}</span>
          </span>
          <span className="activity-row__step" dir="auto">{row.paused ? 'Paused after this step' : (row.step ?? 'Working')}</span>
          {helpers === null ? null : (
            <span className="activity-row__helpers">
              <span className="activity-row__heads" aria-hidden="true">{Array.from({ length: Math.min(row.helpers, 5) }, (_, i) => <i key={i} />)}</span>
              {helpers}
            </span>
          )}
        </span>
        {turn === null ? null : <span className="activity-row__turn">{turn}</span>}
      </button>
    </li>
  );
}

/** Every working session with its office colour, its current step, how long the turn has run and its helpers. */
export function ActivityModal({ onSelect }: ActivityModalProps) {
  const { state } = useStore();
  const now = useNow();
  const rows = activityRows(state.sessions, state.activity, state.rooms);
  const counts = activityCounts(state.sessions, state.activity);
  if (rows.length === 0) {
    return (
      <div className="agency-empty" data-testid="activity-modal">
        <p className="agency-empty__title">All quiet</p>
        <p className="agency-empty__body">Nobody is working right now. Tell {managerName()} a task in the chat below, or start one from the Board.</p>
      </div>
    );
  }
  return (
    <div className="activity" data-testid="activity-modal">
      <p className="activity__sum">{pillWords(counts)}</p>
      <ul className="activity__list">
        {rows.map((row) => <Row key={row.id} row={row} now={now} onSelect={onSelect} />)}
      </ul>
    </div>
  );
}
