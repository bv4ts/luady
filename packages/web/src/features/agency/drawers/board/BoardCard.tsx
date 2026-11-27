import type { BoardItemDTO, MissionDTO, QuestionDTO, SessionActivityDTO, SessionDTO } from '@luady/shared';
import type { PointerEvent } from 'react';
import { useRooms } from '../../../rooms/useRooms.js';
import { teamStyle } from '../../model/team-style.js';
import { cardPalette, needsReason, officeName, runningLine, sessionPalette } from './card-words.js';
import type { LaneId } from './lanes.js';
import { dueState, dueText } from './remind.js';
import { whenText } from './when.js';

export interface CardLive {
  readonly session: SessionDTO | undefined;
  readonly activity: SessionActivityDTO | undefined;
  readonly mission: MissionDTO | undefined;
  readonly question: QuestionDTO | undefined;
}

export interface BoardCardProps {
  readonly card: BoardItemDTO;
  readonly lane: LaneId;
  readonly live: CardLive;
  /** Present when the card can be ticked for Run. */
  readonly picked?: boolean;
  readonly onPick?: (id: number) => void;
  /** Present when the card can be marked done straight from the board. */
  readonly onDone?: (id: number) => void;
  readonly onOpen: (id: number) => void;
  readonly onDragStart?: (card: BoardItemDTO, event: PointerEvent) => void;
}

function Grip() {
  return (
    <svg viewBox="0 0 12 18" width="12" height="18" aria-hidden="true" focusable="false">
      {[3, 9, 15].flatMap((y) => [<circle key={`a${String(y)}`} cx="3.5" cy={y} r="1.6" />, <circle key={`b${String(y)}`} cx="8.5" cy={y} r="1.6" />])}
    </svg>
  );
}

function RunningLine({ card, live }: { card: BoardItemDTO; live: CardLive }) {
  const { session, activity, mission } = live;
  const { list } = useRooms();
  const step = activity?.title ?? null;
  return (
    <div className="paper-card__work">
      <p className="paper-card__session" style={session === undefined ? undefined : teamStyle(sessionPalette(session, list))}>
        <span className="paper-card__dot" aria-hidden="true" data-state={card.state === 'queued' ? 'queued' : (session?.state ?? 'none')} />
        <span dir="auto">{runningLine(card, session)}</span>
      </p>
      {step === null ? null : <p className="paper-card__step" dir="auto">{step}</p>}
      {mission?.note == null ? null : <p className="paper-card__note" dir="auto">{mission.note}</p>}
    </div>
  );
}

/** The due chip on a card; red once the time has passed. */
function DueChip({ card }: { card: BoardItemDTO }) {
  const now = Date.now();
  const text = dueText(card, now);
  return text === null ? null : <span className={`due-chip due-chip--${dueState(card, now)}`}>{text}</span>;
}

/** One paper card on the cork: the office colour on its edge, a pin, the title and its lane's line. */
export function BoardCard({ card, lane, live, picked, onPick, onDone, onOpen, onDragStart }: BoardCardProps) {
  const lookup = useRooms();
  const place = card.project ?? officeName(card.server, lookup);
  const pickable = picked !== undefined && onPick !== undefined;
  const answer = lane === 'needs' && live.question !== undefined;
  return (
    <article className={picked === true ? 'paper-card paper-card--picked' : 'paper-card'} style={teamStyle(cardPalette(card, lookup))}
      data-card={card.id} data-lane={lane} aria-label={card.title}>
      <span className="paper-card__pin" aria-hidden="true" />
      <div className="paper-card__top">
        {place === null ? <span className="paper-card__place paper-card__place--none">No project</span> : <span className="paper-card__place" dir="auto">{place}</span>}
        {card.today ? <span className="paper-card__flag paper-card__flag--today">Today</span> : null}
        {card.priority === 1 ? <span className="paper-card__flag paper-card__flag--high">High</span> : null}
      </div>
      <DueChip card={card} />
      <button type="button" className="paper-card__title" dir="auto" onClick={() => onOpen(card.id)}>{card.title}</button>
      {lane === 'running' ? <RunningLine card={card} live={live} /> : null}
      {lane === 'needs' ? (
        <p className="paper-card__reason" dir="auto">{needsReason(card, live.session, live.question)}</p>
      ) : null}
      {lane === 'done' ? (
        <p className="paper-card__result" dir="auto">{card.result ?? 'Done'}<span className="paper-card__when"> · {whenText(card.doneAt ?? card.updatedAt)}</span></p>
      ) : null}
      {pickable || answer || onDragStart !== undefined ? (
        <div className="paper-card__foot">
          {pickable ? (
            <label className="paper-card__pick">
              <input type="checkbox" checked={picked} onChange={() => onPick(card.id)} />
              <span>Pick</span>
            </label>
          ) : <span />}
          {answer ? (
            <button type="button" className="paper-btn paper-btn--small paper-btn--ink" onClick={() => onOpen(card.id)}>Answer</button>
          ) : null}
          {onDone === undefined ? null : (
            <button type="button" className="paper-btn paper-btn--small paper-card__done" aria-label={`Mark "${card.title}" done`}
              onClick={() => onDone(card.id)}>Done</button>
          )}
          {onDragStart === undefined ? null : (
            <button type="button" className="paper-card__grip" aria-label={`Drag "${card.title}" to a character or a room`}
              title="Drag to a character or a room" onPointerDown={(event) => onDragStart(card, event)}>
              <Grip />
            </button>
          )}
        </div>
      ) : null}
    </article>
  );
}
