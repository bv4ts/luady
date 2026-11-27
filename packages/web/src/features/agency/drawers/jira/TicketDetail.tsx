import type { JiraIssueDetailDTO } from '@luady/shared';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useApi } from '../../../../api/context.js';
import { Markdown } from '../../../../markdown/Markdown.js';
import { useStore } from '../../../../state/store.js';
import { Icon } from '../../../../ui/Icon.js';
import { whenText } from '../account-text.js';
import { useLoaded } from '../library/useLoaded.js';
import { jiraErrorText, notConnected, signInRefused } from './jira-model.js';
import { CommentBox, DescriptionEditor, SummaryEditor } from './TicketEditors.js';
import { TicketFacts } from './TicketFacts.js';
import { PriorityGlyph, StatusLozenge, TypeGlyph } from './TicketGlyphs.js';
import { TicketWork } from './TicketWork.js';

export interface TicketDetailProps {
  readonly server: string;
  readonly issueKey: string;
  readonly onClose: () => void;
  /** After a change: the board fetches again. */
  readonly onChanged: () => void;
  readonly onNotConnected: () => void;
  /** Jira refused the sign-in: the connect form, filled in. */
  readonly onReconnect: () => void;
}

/** What every change returns: the fresh ticket. */
export type TicketChange = (op: () => Promise<JiraIssueDetailDTO>, done: string) => Promise<boolean>;

/** A ticket opened: everything Jira knows, the changes the owner can make, and the ways to send it to work. */
export function TicketDetail({ server, issueKey, onClose, onChanged, onNotConnected, onReconnect }: TicketDetailProps) {
  const api = useApi();
  const { state: store, toast } = useStore();
  const version = store.jiraVersion;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const loaded = useLoaded(useCallback(() => api.jiraIssue(server, issueKey), [api, server, issueKey]), `${server}\n${issueKey}`, version);
  const failed = loaded.state.kind === 'failed' ? loaded.state.error : null;
  useEffect(() => {
    if (failed !== null && notConnected(failed)) onNotConnected();
  }, [failed, onNotConnected]);

  const change: TicketChange = useCallback(async (op, done) => {
    setBusy(true);
    setError(null);
    try {
      loaded.set(await op());
      toast('success', done);
      onChanged();
      return true;
    } catch (err) {
      if (notConnected(err)) onNotConnected();
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  }, [loaded, toast, onChanged, onNotConnected]);

  return (
    <aside className="jira-ticket" aria-label={`Ticket ${issueKey}`}>
      <div className="jira-ticket__top">
        <button type="button" className="jira-btn jira-btn--quiet" onClick={onClose}><Icon name="back" /> Board</button>
        {loaded.state.kind === 'ready' ? (
          <a className="jira-btn jira-btn--quiet" href={loaded.state.value.url} target="_blank" rel="noopener noreferrer">Open in Jira ↗</a>
        ) : null}
      </div>
      {loaded.state.kind === 'loading' ? <p className="jira__quiet" role="status">Opening {issueKey}…</p> : null}
      {failed !== null ? <TicketError error={failed} onReconnect={onReconnect} /> : null}
      {loaded.state.kind === 'ready' ? (
        <Ticket issue={loaded.state.value} server={server} busy={busy} error={error === null ? null : <TicketError error={error} onReconnect={onReconnect} />} change={change} />
      ) : null}
    </aside>
  );
}

function Ticket({ issue, server, busy, error, change }: {
  issue: JiraIssueDetailDTO; server: string; busy: boolean; error: ReactNode; change: TicketChange;
}) {
  const api = useApi();
  const now = new Date();
  return (
    <div className="jira-ticket__body">
      <p className="jira-ticket__crumbs">
        {issue.parent === null ? null : <><span className="jira-key">{issue.parent.key}</span> <span dir="auto">{issue.parent.summary}</span> / </>}
        <TypeGlyph type={issue.type} /> <span className="jira-key">{issue.key}</span>
      </p>
      <SummaryEditor issue={issue} busy={busy} onSave={(summary) => change(() => api.editJira(server, issue.key, { summary }), `${issue.key}: summary saved.`)} />
      <div className="jira-ticket__status">
        <StatusLozenge name={issue.status.name} category={issue.status.category} />
        <PriorityGlyph priority={issue.priority} />
        {issue.flagged ? <span className="jira-flag">Flagged</span> : null}
        <MoveTicket issue={issue} busy={busy}
          onMove={(id, to) => change(() => api.transitionJira(server, issue.key, id), `${issue.key} moved to ${to}.`)} />
      </div>
      {error}
      <TicketWork issue={issue} server={server} />
      <div className="jira-ticket__cols">
        <div className="jira-ticket__text">
          <DescriptionEditor issue={issue} busy={busy}
            onSave={(description) => change(() => api.editJira(server, issue.key, { description }), `${issue.key}: description saved.`)} />
          {issue.subtasks.length === 0 ? null : (
            <section aria-label="Sub-tasks">
              <h4 className="jira-ticket__sub">Sub-tasks</h4>
              <ul className="jira-subtasks">
                {issue.subtasks.map((sub) => (
                  <li key={sub.key}><span className="jira-key">{sub.key}</span> <span dir="auto">{sub.summary}</span> <span className="jira__quiet">· {sub.status}</span></li>
                ))}
              </ul>
            </section>
          )}
          <section aria-label="Comments">
            <h4 className="jira-ticket__sub">Comments <span className="jira__quiet">{issue.comments.length}</span></h4>
            <CommentBox busy={busy} onSend={(text) => change(() => api.commentJira(server, issue.key, text), `Comment added to ${issue.key}.`)} />
            <ol className="jira-comments">
              {issue.comments.toReversed().map((comment) => (
                <li key={comment.id} className="jira-comment">
                  <p className="jira-comment__who"><strong dir="auto">{comment.author}</strong> <span className="jira__quiet">{whenText(comment.at, now)}</span></p>
                  <Markdown source={comment.bodyMd} className="jira-md" />
                </li>
              ))}
            </ol>
          </section>
        </div>
        <TicketFacts issue={issue} busy={busy} server={server} change={change} />
      </div>
    </div>
  );
}

function MoveTicket({ issue, busy, onMove }: { issue: JiraIssueDetailDTO; busy: boolean; onMove: (id: string, to: string) => Promise<boolean> }) {
  const [choice, setChoice] = useState('');
  if (issue.transitions.length === 0) return null;
  const picked = issue.transitions.find((t) => t.id === choice);
  return (
    <span className="jira-move">
      <label className="jira-visually-hidden" htmlFor={`move-${issue.key}`}>Move to</label>
      <select id={`move-${issue.key}`} className="jira-input jira-input--small" value={choice} disabled={busy} onChange={(event) => setChoice(event.target.value)}>
        <option value="">Move to…</option>
        {issue.transitions.map((t) => <option key={t.id} value={t.id}>{t.name === t.to ? t.to : `${t.name} → ${t.to}`}</option>)}
      </select>
      <button type="button" className="jira-btn jira-btn--primary" disabled={busy || picked === undefined}
        onClick={() => { if (picked !== undefined) void onMove(picked.id, picked.to).then((ok) => { if (ok) setChoice(''); }); }}>Move</button>
    </span>
  );
}

/** A failed load or change in plain words; when Jira refused the sign-in, a way to connect again. */
function TicketError({ error, onReconnect }: { error: unknown; onReconnect: () => void }) {
  return (
    <div className="jira-form__failure" role="alert">
      <p className="jira-failure__text">{jiraErrorText(error)}</p>
      {signInRefused(error) ? <button type="button" className="jira-btn jira-btn--primary" onClick={onReconnect}>Sign in again</button> : null}
    </div>
  );
}
