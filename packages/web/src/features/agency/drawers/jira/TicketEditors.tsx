import { LIMITS, type JiraIssueDetailDTO } from '@luady/shared';
import { useId, useState } from 'react';
import { Markdown } from '../../../../markdown/Markdown.js';

/** The summary as the title, with an Edit that turns it into a field. */
export function SummaryEditor({ issue, busy, onSave }: { issue: JiraIssueDetailDTO; busy: boolean; onSave: (summary: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  if (draft === null) {
    return (
      <div className="jira-ticket__title-row">
        <h3 className="jira-ticket__title" dir="auto">{issue.summary}</h3>
        <button type="button" className="jira-btn jira-btn--quiet" disabled={busy} onClick={() => setDraft(issue.summary)}>Edit summary</button>
      </div>
    );
  }
  const text = draft.trim();
  return (
    <form className="jira-edit" onSubmit={(event) => {
      event.preventDefault();
      if (text !== '' && text !== issue.summary) void onSave(text).then((ok) => { if (ok) setDraft(null); });
    }}>
      <label className="jira-form__label" htmlFor={id}>Summary</label>
      <input id={id} className="jira-input" dir="auto" maxLength={LIMITS.jiraSummaryMax} value={draft} onChange={(event) => setDraft(event.target.value)} />
      <div className="jira-form__row">
        <button type="submit" className="jira-btn jira-btn--primary" disabled={busy || text === '' || text === issue.summary}>Save summary</button>
        <button type="button" className="jira-btn jira-btn--quiet" onClick={() => setDraft(null)}>Cancel</button>
      </div>
    </form>
  );
}

/** The description (Markdown from the hub, through the sanitising renderer) and its editor. */
export function DescriptionEditor({ issue, busy, onSave }: { issue: JiraIssueDetailDTO; busy: boolean; onSave: (text: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  return (
    <section aria-label="Description">
      <div className="jira-ticket__sub-row">
        <h4 className="jira-ticket__sub">Description</h4>
        {draft === null ? <button type="button" className="jira-btn jira-btn--quiet" disabled={busy} onClick={() => setDraft(issue.descriptionMd)}>Edit description</button> : null}
      </div>
      {draft === null ? (
        issue.descriptionMd.trim() === '' ? <p className="jira__quiet">No description.</p> : <Markdown source={issue.descriptionMd} className="jira-md" />
      ) : (
        <form className="jira-edit" onSubmit={(event) => { event.preventDefault(); void onSave(draft).then((ok) => { if (ok) setDraft(null); }); }}>
          <label className="jira-visually-hidden" htmlFor={id}>Description</label>
          <textarea id={id} className="jira-input jira-input--area" dir="auto" rows={10} maxLength={LIMITS.jiraDescriptionMax} value={draft}
            onChange={(event) => setDraft(event.target.value)} />
          <p className="jira-form__hint">Jira gets this as plain text: a blank line starts a new paragraph.</p>
          <div className="jira-form__row">
            <button type="submit" className="jira-btn jira-btn--primary" disabled={busy || draft === issue.descriptionMd}>Save description</button>
            <button type="button" className="jira-btn jira-btn--quiet" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

/** A new comment; the box empties once Jira has it. */
export function CommentBox({ busy, onSend }: { busy: boolean; onSend: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const id = useId();
  const value = text.trim();
  return (
    <form className="jira-edit jira-comment-box" onSubmit={(event) => {
      event.preventDefault();
      if (value !== '') void onSend(value).then((ok) => { if (ok) setText(''); });
    }}>
      <label className="jira-visually-hidden" htmlFor={id}>Add a comment</label>
      <textarea id={id} className="jira-input jira-input--area" dir="auto" rows={2} placeholder="Add a comment…" maxLength={LIMITS.jiraCommentMax}
        value={text} onChange={(event) => setText(event.target.value)} />
      <div className="jira-form__row">
        <button type="submit" className="jira-btn jira-btn--primary" disabled={busy || value === ''}>Comment</button>
      </div>
    </form>
  );
}
