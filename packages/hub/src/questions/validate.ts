import type { AskQuestion } from '@luady/shared';
import { ValidationError } from '../core/errors.js';
import { looksLikePin } from '../web/pin-guard.js';

export const ANSWER_MAX_CHARS = 5_000;
export const PERMISSION_MESSAGE_MAX = 1_000;
/** How to send a real number shaped like the PIN (a code, a ticket number): with a word in front, it is no longer PIN-shaped. */
export const NUMBER_ANSWER_HINT = 'To send a real number of 6 to 12 digits (a code a session asks for), put a word in front of it, such as "code" or "ticket".';
export const PIN_ANSWER_MESSAGE = `That answer looks like a PIN, so it was not sent. No session ever needs your PIN: it only approves a confirmation. ${NUMBER_ANSWER_HINT}`;

/**
 * A session's question could be fishing for the PIN, so an answer shaped like one is never delivered or stored. One of
 * the question's own option labels is still fine: the session offered it.
 */
function assertNotPinAnswer(question: AskQuestion | undefined, value: string): void {
  const offered = question?.options.some((option) => option.label === value) === true;
  if (!offered && looksLikePin(value)) throw new ValidationError(PIN_ANSWER_MESSAGE);
}

/** A permission denial's message goes to the session too: never one shaped like the PIN. */
export function assertNotPinMessage(message: string | undefined): void {
  if (message !== undefined) assertNotPinAnswer(undefined, message);
}

/** Keys must be exactly the question texts; every value must be non-blank text (a label, "a, b", or free text). */
export function validateAnswers(questions: readonly AskQuestion[], answers: Readonly<Record<string, string>>): void {
  const expected = questions.map((entry) => entry.question);
  const missing = expected.filter((text) => !Object.hasOwn(answers, text));
  if (missing.length > 0) throw new ValidationError(`missing answer for: ${missing.join(' | ')}`);
  const unknown = Object.keys(answers).filter((key) => !expected.includes(key));
  if (unknown.length > 0) throw new ValidationError(`no such question: ${unknown.join(' | ')}`);
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value !== 'string' || value.trim() === '') throw new ValidationError(`empty answer for: ${key}`);
    if (value.length > ANSWER_MAX_CHARS) throw new ValidationError(`answer too long for: ${key}`);
    assertNotPinAnswer(questions.find((entry) => entry.question === key), value);
  }
}

/** Searchable text of a question (messages row, role `assistant`). */
export function questionText(qid: string, questions: readonly AskQuestion[]): string {
  const blocks = questions.map((entry, index) => {
    const head = questions.length > 1 ? `${index + 1}. ${entry.question}` : entry.question;
    const options = entry.options.map((option, i) => `   ${i + 1}) ${option.label}${option.description ? ` — ${option.description}` : ''}`);
    return [head, ...options].join('\n');
  });
  return [`❓ #${qid}`, ...blocks].join('\n');
}

/** Searchable text of the owner's answers (messages row, role `owner`). */
export function answerText(qid: string, answers: Readonly<Record<string, string>>): string {
  return [`↩ #${qid}`, ...Object.entries(answers).map(([asked, answer]) => `${asked} → ${answer}`)].join('\n');
}
