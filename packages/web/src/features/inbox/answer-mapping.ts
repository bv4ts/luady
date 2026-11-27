import type { AskQuestion } from '@luady/shared';

/** AnswerBodySchema limits. */
export const FREE_TEXT_MAX = 5000;
export const PERMISSION_MESSAGE_MAX = 1000;

export interface QuestionDraft {
  readonly selected: readonly string[];
  readonly other: string;
  readonly useOther: boolean;
}

export const EMPTY_DRAFT: QuestionDraft = { selected: [], other: '', useOther: false };

export type Mapped<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

export function toggleOption(question: AskQuestion, draft: QuestionDraft, label: string): QuestionDraft {
  if (!question.multiSelect) return { selected: [label], other: draft.other, useOther: false };
  const selected = draft.selected.includes(label) ? draft.selected.filter((l) => l !== label) : [...draft.selected, label];
  return { selected, other: draft.other, useOther: false };
}

export function chooseOther(draft: QuestionDraft, useOther: boolean): QuestionDraft {
  return { selected: useOther ? [] : draft.selected, other: draft.other, useOther };
}

export function setOtherText(_draft: QuestionDraft, text: string): QuestionDraft {
  return { selected: [], other: text, useOther: true };
}

function answerFor(question: AskQuestion, draft: QuestionDraft): Mapped<string> {
  if (draft.useOther || question.options.length === 0) {
    if (draft.other.trim() === '') return { ok: false, error: 'Type your answer.' };
    if (draft.other.length > FREE_TEXT_MAX) return { ok: false, error: `Keep the answer under ${FREE_TEXT_MAX} characters.` };
    return { ok: true, value: draft.other };
  }
  const labels = question.options.map((option) => option.label).filter((label) => draft.selected.includes(label));
  if (labels.length === 0) return { ok: false, error: question.multiSelect ? 'Pick at least one option.' : 'Pick an option.' };
  if (!question.multiSelect && labels.length > 1) return { ok: false, error: 'Pick only one option.' };
  return { ok: true, value: labels.join(', ') };
}

/** Builds `{ answers: { "<exact question text>": "<label(s) or free text>" } }`. */
export function buildAnswers(questions: readonly AskQuestion[], drafts: readonly QuestionDraft[]): Mapped<{ answers: Record<string, string> }> {
  const seen = new Set<string>();
  const entries: Array<[string, string]> = [];
  for (const [index, question] of questions.entries()) {
    const prefix = questions.length > 1 ? `Question ${index + 1}: ` : '';
    const result = answerFor(question, drafts[index] ?? EMPTY_DRAFT);
    if (!result.ok) return { ok: false, error: `${prefix}${result.error}` };
    if (seen.has(question.question)) return { ok: false, error: `${prefix}Two questions share the same text. Answer this one in the terminal.` };
    seen.add(question.question);
    entries.push([question.question, result.value]);
  }
  return { ok: true, value: { answers: Object.fromEntries(entries) } };
}

export type PermissionAnswer = { behavior: 'allow' | 'deny'; message?: string; always?: true };

/** `always` (the preview's "Allow always" rule for this session) belongs to an allow only (AnswerBodySchema). */
export function buildPermissionAnswer(behavior: 'allow' | 'deny', message: string, always = false): Mapped<PermissionAnswer> {
  const trimmed = message.trim();
  if (trimmed.length > PERMISSION_MESSAGE_MAX) return { ok: false, error: `Keep the message under ${PERMISSION_MESSAGE_MAX} characters.` };
  if (always && behavior !== 'allow') return { ok: false, error: 'Allow always goes with Allow only.' };
  const base: PermissionAnswer = trimmed === '' ? { behavior } : { behavior, message: trimmed };
  return { ok: true, value: always ? { ...base, always: true } : base };
}
