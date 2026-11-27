import type { AskQuestion, QuestionDTO } from '@luady/shared';
import { useState } from 'react';
import { Button } from '../../ui/Button.js';
import { TextAreaField } from '../../ui/Field.js';
import {
  EMPTY_DRAFT, FREE_TEXT_MAX, buildAnswers, chooseOther, setOtherText, toggleOption, type QuestionDraft,
} from './answer-mapping.js';
import { CardHead } from './CardHead.js';
import { useQuestionActions } from './useQuestionActions.js';

function QuestionBlock({ group, number, question, draft, onChange }: {
  group: string; number: string; question: AskQuestion; draft: QuestionDraft; onChange: (next: QuestionDraft) => void;
}) {
  const multi = question.multiSelect === true;
  const type = multi ? 'checkbox' : 'radio';
  const freeTextOnly = question.options.length === 0;
  return (
    <fieldset className="qblock">
      <legend className="qblock__legend">
        {question.header ? <span className="chip">{question.header}</span> : null}
        <span className="qblock__text" dir="auto">{number}{question.question}</span>
        {multi ? <span className="text-subtle">Choose one or more</span> : null}
      </legend>
      {freeTextOnly ? null : (
        <div className="qblock__options">
          {question.options.map((option) => (
            <label key={option.label} className="choice">
              <input type={type} name={group} checked={!draft.useOther && draft.selected.includes(option.label)}
                onChange={() => onChange(toggleOption(question, draft, option.label))} />
              <span>
                <span className="choice__label" dir="auto" data-testid="question-option">{option.label}</span>
                {option.description ? <span className="choice__desc" dir="auto">{option.description}</span> : null}
              </span>
            </label>
          ))}
          <label className="choice">
            <input type={type} name={group} checked={draft.useOther}
              onChange={(event) => onChange(chooseOther(draft, multi ? event.target.checked : true))} />
            <span><span className="choice__label">Other</span><span className="choice__desc">Type your own answer</span></span>
          </label>
        </div>
      )}
      {draft.useOther || freeTextOnly ? (
        <TextAreaField label="Your answer" value={draft.other} rows={3} maxLength={FREE_TEXT_MAX} dir="auto"
          onChange={(event) => onChange(setOtherText(draft, event.target.value))} />
      ) : null}
    </fieldset>
  );
}

export function QuestionCard({ question }: { question: QuestionDTO }) {
  const { answer, release, busy, error, setError } = useQuestionActions(question);
  const [drafts, setDrafts] = useState<readonly QuestionDraft[]>(() => question.questions.map(() => EMPTY_DRAFT));
  const many = question.questions.length > 1;

  function update(index: number, next: QuestionDraft) {
    setDrafts((prev) => prev.map((draft, i) => (i === index ? next : draft)));
  }

  function submit() {
    const result = buildAnswers(question.questions, drafts);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    void answer(result.value);
  }

  return (
    <article className="qcard" aria-label={`Question #${question.qid}`} data-testid="question-card" data-qid={question.qid}>
      <CardHead kind="Question" tone="waiting" label={question.sessionLabel} sessionId={question.sessionId}
        reference={question.qid} createdAt={question.createdAt} />
      <form className="stack stack--lg" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {question.questions.map((q, index) => (
          <QuestionBlock key={`${question.qid}-${index}`} group={`${question.qid}-${index}`} number={many ? `${index + 1}. ` : ''}
            question={q} draft={drafts[index] ?? EMPTY_DRAFT} onChange={(next) => update(index, next)} />
        ))}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="qcard__actions">
          <Button type="submit" variant="primary" icon="send" busy={busy === 'answer'} disabled={busy !== null}
            data-testid="question-submit">Send answer</Button>
          <Button variant="ghost" busy={busy === 'release'} disabled={busy !== null} onClick={() => void release()}>Answer in terminal</Button>
        </div>
      </form>
    </article>
  );
}
