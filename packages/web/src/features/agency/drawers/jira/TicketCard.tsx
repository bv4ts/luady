import type { JiraIssueDTO } from '@luady/shared';
import { useGive } from '../../give/GiveContext.js';
import { PriorityGlyph, TypeGlyph } from './TicketGlyphs.js';

/** One ticket on the board: key, summary, type, priority, a dot when it has news; a handle to drag it to a session. */
export function TicketCard({ issue, server, selected, onOpen }: {
  issue: JiraIssueDTO; server: string; selected: boolean; onOpen: () => void;
}) {
  const { startDrag } = useGive();
  return (
    <article className={`jira-card${selected ? ' jira-card--selected' : ''}${issue.flagged ? ' jira-card--flagged' : ''}`} aria-label={issue.key}>
      <button type="button" className="jira-card__open" aria-pressed={selected} onClick={onOpen}>
        <span className="jira-card__summary" dir="auto">{issue.summary}</span>
        <span className="jira-card__foot">
          <TypeGlyph type={issue.type} />
          <span className="jira-key">{issue.key}</span>
          {issue.flagged ? <span className="jira-flag" title="Flagged">Flagged</span> : null}
          <PriorityGlyph priority={issue.priority} />
          {issue.hasNews ? <span className="jira-news" title="Changed since you last opened it"><span className="jira-visually-hidden">New changes</span></span> : null}
        </span>
      </button>
      <button type="button" className="jira-card__grip" aria-label={`Drag ${issue.key} to a session or a room`} title="Drag to a session or a room"
        onPointerDown={(event) => startDrag([{ kind: 'jira', server, key: issue.key }], issue.key, event)}>
        <span aria-hidden="true">⠿</span>
      </button>
    </article>
  );
}
