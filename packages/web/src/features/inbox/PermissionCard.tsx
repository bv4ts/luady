import { permissionAllowOffered, type QuestionDTO } from '@luady/shared';
import { useId, useState } from 'react';
import { Button } from '../../ui/Button.js';
import { TextAreaField } from '../../ui/Field.js';
import { PERMISSION_MESSAGE_MAX, buildPermissionAnswer } from './answer-mapping.js';
import { ApprovalPreview } from './ApprovalPreview.js';
import { CardHead } from './CardHead.js';
import { useQuestionActions } from './useQuestionActions.js';

type Choice = 'allow' | 'always' | 'deny';
type Risk = NonNullable<QuestionDTO['permission']>['risk'];

/** "Risky: force push" as a line of text on a red card. Nothing for other levels. */
function RiskLine({ risk }: { risk: Risk }) {
  if (risk?.level !== 'risky') return null;
  return <p className="qcard__risk">{risk.reason === '' ? 'Risky' : `Risky: ${risk.reason}`}</p>;
}

/**
 * A permission request: what exactly it wants to do (the command or the changed lines), the hub's risk mark, and
 * Allow, Allow always (when the preview offers it), Deny and Answer in terminal. "Read-only" shows only when the hub
 * says safe, which it never does for a cut or redacted command. A request with a hidden part (any tool) offers no
 * Allow at all: only Deny and Answer in terminal, with the reason.
 */
export function PermissionCard({ question }: { question: QuestionDTO }) {
  const { answer, release, busy, error, setError } = useQuestionActions(question);
  const [message, setMessage] = useState('');
  const [choice, setChoice] = useState<Choice | null>(null);
  const alwaysHint = useId();
  const permission = question.permission;
  const allowOffered = permission === null || permissionAllowOffered(permission);
  const always = allowOffered ? permission?.preview?.always ?? null : null;
  const risk = permission?.risk;

  function decide(next: Choice) {
    const result = buildPermissionAnswer(next === 'deny' ? 'deny' : 'allow', message, next === 'always');
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setChoice(next);
    void answer(result.value);
  }

  const answering = (which: Choice) => busy === 'answer' && choice === which;
  return (
    <article className={risk?.level === 'risky' ? 'qcard qcard--risky' : 'qcard'} aria-label={`Permission request #${question.qid}`}>
      <CardHead kind="Permission" tone="waiting" label={question.sessionLabel} sessionId={question.sessionId}
        reference={question.qid} createdAt={question.createdAt} />
      <p className="qcard__summary">
        Wants to use <span className="mono">{permission?.toolName ?? 'a tool'}</span>
        {risk?.level === 'safe' ? <> <span className="qcard__safe">Read-only</span></> : null}
      </p>
      <RiskLine risk={risk} />
      {permission ? <ApprovalPreview permission={permission} allowOffered={allowOffered} /> : null}
      <div className="qcard__actions">
        {allowOffered ? (
          <Button variant="primary" icon="check" busy={answering('allow')} disabled={busy !== null} data-testid="approval-allow"
            onClick={() => decide('allow')}>Allow</Button>
        ) : null}
        {always === null ? null : (
          <Button variant="secondary" icon="check" busy={answering('always')} disabled={busy !== null} data-testid="approval-allow-always"
            aria-describedby={alwaysHint} onClick={() => decide('always')}>Allow always</Button>
        )}
        <Button variant="danger" icon="x" busy={answering('deny')} disabled={busy !== null} data-testid="approval-deny"
          onClick={() => decide('deny')}>Deny</Button>
        <Button variant={allowOffered ? 'ghost' : 'primary'} busy={busy === 'release'} disabled={busy !== null}
          data-testid="approval-terminal" onClick={() => void release()}>Answer in terminal</Button>
      </div>
      {always === null ? null : <p id={alwaysHint} className="qcard__hint" dir="auto">{`For the rest of this session: ${always.label}`}</p>}
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <TextAreaField label="Message to Claude (optional)"
        hint={allowOffered ? 'Sent with Allow or Deny, for example why you denied it.' : 'Sent with Deny, for example why you denied it.'}
        value={message} rows={2} maxLength={PERMISSION_MESSAGE_MAX} dir="auto" onChange={(event) => setMessage(event.target.value)} />
    </article>
  );
}
