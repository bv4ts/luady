import type { JiraIssueDetailDTO } from '@luady/shared';
import { useId, useState } from 'react';
import { useApi } from '../../../../api/context.js';
import { whenText } from '../account-text.js';
import { PRIORITIES, dayText, parseLabels } from './jira-model.js';
import type { TicketChange } from './TicketDetail.js';

/** The side column: people, priority, labels, sprint and dates, with the changes that belong to them. */
export function TicketFacts({ issue, busy, server, change }: { issue: JiraIssueDetailDTO; busy: boolean; server: string; change: TicketChange }) {
  const api = useApi();
  const now = new Date();
  const id = useId();
  const [labels, setLabels] = useState<string | null>(null);
  const priorities = issue.priority === null || PRIORITIES.includes(issue.priority) ? PRIORITIES : [issue.priority, ...PRIORITIES];

  return (
    <dl className="jira-facts">
      <div>
        <dt>Assignee</dt>
        <dd>
          <span dir="auto">{issue.assignee ?? 'Nobody'}</span>
          <span className="jira-facts__actions">
            <button type="button" className="jira-btn jira-btn--small" disabled={busy}
              onClick={() => void change(() => api.assignJira(server, issue.key, true), `${issue.key} is assigned to you.`)}>Assign to me</button>
            {issue.assignee === null ? null : (
              <button type="button" className="jira-btn jira-btn--small jira-btn--quiet" disabled={busy}
                onClick={() => void change(() => api.assignJira(server, issue.key, false), `${issue.key} has no assignee now.`)}>Unassign</button>
            )}
          </span>
        </dd>
      </div>
      <div><dt>Reporter</dt><dd dir="auto">{issue.reporter ?? '—'}</dd></div>
      <div>
        <dt><label htmlFor={`${id}-prio`}>Priority</label></dt>
        <dd>
          <select id={`${id}-prio`} className="jira-input jira-input--small" value={issue.priority ?? ''} disabled={busy}
            onChange={(event) => {
              const priority = event.target.value;
              if (priority !== '' && priority !== issue.priority) void change(() => api.editJira(server, issue.key, { priority }), `${issue.key}: priority ${priority}.`);
            }}>
            {issue.priority === null ? <option value="">None</option> : null}
            {priorities.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </dd>
      </div>
      <div>
        <dt>Labels</dt>
        <dd>
          {labels === null ? (
            <>
              <span className="jira-labels">{issue.labels.length === 0 ? <span className="jira__quiet">None</span> : issue.labels.map((l) => <span key={l} className="jira-label">{l}</span>)}</span>
              <button type="button" className="jira-btn jira-btn--small jira-btn--quiet" disabled={busy} onClick={() => setLabels(issue.labels.join(' '))}>Edit labels</button>
            </>
          ) : (
            <form className="jira-edit" onSubmit={(event) => {
              event.preventDefault();
              void change(() => api.editJira(server, issue.key, { labels: parseLabels(labels) }), `${issue.key}: labels saved.`).then((ok) => { if (ok) setLabels(null); });
            }}>
              <label className="jira-visually-hidden" htmlFor={`${id}-labels`}>Labels, separated by spaces</label>
              <input id={`${id}-labels`} className="jira-input jira-input--small" value={labels} placeholder="web checkout" onChange={(event) => setLabels(event.target.value)} />
              <span className="jira-facts__actions">
                <button type="submit" className="jira-btn jira-btn--small jira-btn--primary" disabled={busy}>Save labels</button>
                <button type="button" className="jira-btn jira-btn--small jira-btn--quiet" onClick={() => setLabels(null)}>Cancel</button>
              </span>
            </form>
          )}
        </dd>
      </div>
      <div><dt>Sprint</dt><dd dir="auto">{issue.sprint ?? '—'}</dd></div>
      {issue.parent === null ? null : <div><dt>Parent</dt><dd><span className="jira-key">{issue.parent.key}</span> <span dir="auto">{issue.parent.summary}</span></dd></div>}
      <div><dt>Due</dt><dd>{issue.dueDate === null ? '—' : dayText(issue.dueDate)}</dd></div>
      <div><dt>Created</dt><dd>{whenText(issue.createdAt, now)}</dd></div>
      <div><dt>Updated</dt><dd>{whenText(issue.updatedAt, now)}</dd></div>
    </dl>
  );
}
