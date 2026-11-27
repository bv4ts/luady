import type { BoardEventDTO, BoardItemDTO, MissionDTO, QuestionDTO, SaidDTO, SessionDTO } from '@luady/shared';
import { Markdown } from '../../../../markdown/Markdown.js';
import { PermissionCard } from '../../../inbox/PermissionCard.js';
import { QuestionCard } from '../../../inbox/QuestionCard.js';
import { useRooms } from '../../../rooms/useRooms.js';
import { teamStyle } from '../../model/team-style.js';
import { eventWords, sessionPalette, sessionStateWords } from './card-words.js';
import { whenText } from './when.js';
import '../../../inbox/inbox.css';

const REPORT_KINDS = new Set<BoardEventDTO['kind']>(['report', 'blocked', 'done']);

/** The session's reports about this card: progress, blocked and done lines, oldest first. */
export function reportsOf(events: readonly BoardEventDTO[]): readonly BoardEventDTO[] {
  return events.filter((event) => REPORT_KINDS.has(event.kind));
}

/** The session's last message: the mission's copy, else what it said last on the map. */
export function lastMessage(mission: MissionDTO | null | undefined, said: SaidDTO | undefined): string | null {
  return mission?.lastText ?? said?.text ?? null;
}

export interface CardWorkProps {
  readonly card: BoardItemDTO;
  readonly session: SessionDTO | undefined;
  readonly mission: MissionDTO | null | undefined;
  readonly said: SaidDTO | undefined;
  readonly question: QuestionDTO | undefined;
  readonly events: readonly BoardEventDTO[];
  readonly onOpenAgent: ((sessionId: string) => void) | null;
}

/** For a card that is or was worked on: its session, the mission note and turns, the last message, reports, result. */
export function CardWork({ card, session, mission, said, question, events, onOpenAgent }: CardWorkProps) {
  const { list } = useRooms();
  const reports = reportsOf(events);
  const last = lastMessage(mission, said);
  const turns = mission?.turns ?? 0;
  return (
    <section className="card-sheet__work" aria-label="The work">
      {question === undefined ? null : (
        <div className="card-sheet__answer">
          {question.kind === 'permission' ? <PermissionCard question={question} /> : <QuestionCard question={question} />}
        </div>
      )}
      {card.sessionId === null ? null : (
        <div className="card-sheet__session" style={session === undefined ? undefined : teamStyle(sessionPalette(session, list))}>
          <span className="card-sheet__swatch" aria-hidden="true" />
          <div className="card-sheet__session-words">
            <strong dir="auto">{session?.displayName ?? mission?.label ?? 'The session'}</strong>
            <span>{sessionStateWords(session)}{turns > 0 ? ` · ${String(turns)} ${turns === 1 ? 'turn' : 'turns'}` : ''}</span>
          </div>
          {onOpenAgent !== null && card.state !== 'running' && session !== undefined && session.state !== 'ended' ? (
            <button type="button" className="paper-btn paper-btn--small" onClick={() => onOpenAgent(session.id)}>Open agent</button>
          ) : null}
        </div>
      )}
      {mission == null ? null : (
        <div className="card-sheet__mission">
          <h4>Mission</h4>
          <p dir="auto">{mission.title}</p>
          {mission.note === null ? null : <p className="card-sheet__quiet" dir="auto">{mission.note}</p>}
        </div>
      )}
      {last === null ? null : (
        <div className="card-sheet__last">
          <h4>Last message</h4>
          <Markdown source={last} className="card-sheet__said" />
        </div>
      )}
      {reports.length === 0 ? null : (
        <div className="card-sheet__reports">
          <h4>Reports</h4>
          <ul>
            {reports.map((event) => (
              <li key={event.id} data-kind={event.kind}>
                <span className="card-sheet__report-kind">{eventWords(event.kind)}</span>
                <span dir="auto">{event.text}</span>
                <time dateTime={event.at}>{whenText(event.at)}</time>
              </li>
            ))}
          </ul>
        </div>
      )}
      {card.result === null ? null : (
        <div className="card-sheet__result">
          <h4>Result</h4>
          <p dir="auto">{card.result}</p>
        </div>
      )}
    </section>
  );
}

/** Everything that happened to the card, newest first. */
export function CardLog({ events }: { events: readonly BoardEventDTO[] }) {
  if (events.length === 0) return null;
  return (
    <section className="card-sheet__log" aria-label="Log">
      <h4>Log</h4>
      <ol>
        {events.toReversed().map((event) => (
          <li key={event.id}>
            <time dateTime={event.at}>{whenText(event.at)}</time>
            <span className="card-sheet__log-kind">{eventWords(event.kind)}</span>
            {event.text === '' ? null : <span className="card-sheet__log-text" dir="auto">{event.text}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
