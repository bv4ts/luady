import { PIN_RE, QID_RE, type AskQuestion, type QuestionDTO } from '@luady/shared';
import { lineCountHelp, optionRangeHelp, questionGoneNotice, singleChoiceHelp } from '../notify/format.js';

export const OPTION_LIST_RE = /^\d+(\s*,\s*\d+)*$/;
const ALLOW_RE = /^(y|yes|allow|ok|نعم)$/i;
const DENY_RE = /^(n|no|deny|لا)$/i;
const ACTION_DENY_RE = /^(no|cancel|لا)$/i;
const SIMPLE_COMMAND_RE = /^\/(status|q|away|back|help|missions|sessions|reset|today|todo|google)$/i;
/** `/todo buy milk`: the text after the command, as the owner wrote it. */
const TODO_ADD_RE = /^\/todo\s+([\s\S]+)$/i;
const MUTE_COMMAND_RE = /^\/mute(?:\s+(\S+))?$/i;
const NEW_COMMAND_RE = /^\/new(?:\s+([\s\S]*))?$/i;
const NEW_ARGS_RE = /^(\S+)\s+(\S+)\s+([\s\S]+)$/;
const LOCAL_COMMAND_RE = /^\/local(?:\s+(\S+))?$/i;
const LOGIN_COMMAND_RE = /^\/login(?:\s+(\S+))?$/i;
const WISPR_COMMAND_RE = /^\/wispr(?:\s+(\S+))?$/i;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; help: string };
export type SimpleCommandName = 'status' | 'q' | 'away' | 'back' | 'help' | 'missions' | 'sessions' | 'reset' | 'today' | 'todo' | 'google';
export type Command =
  | { name: SimpleCommandName }
  | { name: 'local'; qid: string | null }
  | { name: 'mute'; arg: string | null }
  | { name: 'login'; arg: string | null }
  | { name: 'wispr'; arg: string | null }
  | { name: 'todo_add'; text: string }
  | { name: 'new'; server: string; project: string; task: string }
  | { name: 'new'; server: null; project: null; task: null };
export type ActionReply = { kind: 'pin'; pin: string } | { kind: 'deny' } | { kind: 'unknown' };

export interface PermissionReply {
  behavior: 'allow' | 'deny';
  message?: string;
}

const SIMPLE_COMMANDS: Record<string, SimpleCommandName> = {
  status: 'status', q: 'q', away: 'away', back: 'back', help: 'help',
  missions: 'missions', sessions: 'sessions', reset: 'reset', today: 'today', todo: 'todo', google: 'google',
};
const EASTERN_DIGIT_RE = /[\u0660-\u0669\u06F0-\u06F9\u060C]/g;
const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;
const ARABIC_COMMA = '\u060C';

/** Arabic-Indic and Extended Arabic-Indic digits become ASCII 0–9; the Arabic comma becomes ','. */
export function normalizeDigits(text: string): string {
  return text.replace(EASTERN_DIGIT_RE, (char) => {
    if (char === ARABIC_COMMA) return ',';
    const code = char.charCodeAt(0);
    return String(code - (code >= EXTENDED_ARABIC_INDIC_ZERO ? EXTENDED_ARABIC_INDIC_ZERO : ARABIC_INDIC_ZERO));
  });
}

export function isOptionList(text: string): boolean {
  return OPTION_LIST_RE.test(normalizeDigits(text).trim());
}

export function looksLikePin(text: string): boolean {
  return PIN_RE.test(normalizeDigits(text).trim());
}

/** Only digits, with the spaces, dots, commas and dashes speech puts between them. */
const SPOKEN_DIGITS_RE = /^[\d\s.,-]+$/;
const DIGIT_GAPS_RE = /[\s.,-]/g;
/** Long enough for any spoken PIN with its gaps; a longer text is never one. */
const SPOKEN_PIN_MAX = 64;

/** Spoken words (a phone call, a transcribed voice note) that are a PIN said digit by digit, like "4 8 2 9 1 3". */
export function soundsLikePin(words: string): boolean {
  const digits = normalizeDigits(words).trim();
  if (digits.length > SPOKEN_PIN_MAX || !SPOKEN_DIGITS_RE.test(digits)) return looksLikePin(digits);
  return looksLikePin(digits.replace(DIGIT_GAPS_RE, ''));
}

function uniqueNumbers(text: string): number[] {
  const numbers = text.split(',').map((part) => Number.parseInt(part.trim(), 10));
  return numbers.filter((n, index) => numbers.indexOf(n) === index);
}

export function parseSingleAnswer(qid: string, question: AskQuestion, text: string): ParseResult<string> {
  const trimmed = text.trim();
  const digits = normalizeDigits(trimmed);
  const count = question.options.length;
  if (trimmed === '') return { ok: false, help: optionRangeHelp(qid, Math.max(count, 1)) };
  if (count === 0 || !OPTION_LIST_RE.test(digits)) return { ok: true, value: trimmed };
  const numbers = uniqueNumbers(digits);
  if (numbers.some((n) => n < 1 || n > count)) return { ok: false, help: optionRangeHelp(qid, count) };
  if (numbers.length > 1 && question.multiSelect !== true) return { ok: false, help: singleChoiceHelp(qid) };
  const labels = numbers.map((n) => question.options[n - 1]?.label ?? '');
  return { ok: true, value: labels.join(', ') };
}

export function parseQuestionReply(
  qid: string,
  questions: readonly AskQuestion[],
  text: string,
): ParseResult<Record<string, string>> {
  if (questions.length <= 1) {
    const only = questions[0];
    if (!only) return { ok: false, help: questionGoneNotice(qid) };
    const answer = parseSingleAnswer(qid, only, text);
    return answer.ok ? { ok: true, value: { [only.question]: answer.value } } : answer;
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length !== questions.length) return { ok: false, help: lineCountHelp(qid, questions.length) };
  return questions.reduce<ParseResult<Record<string, string>>>((acc, question, index) => {
    if (!acc.ok) return acc;
    const answer = parseSingleAnswer(qid, question, lines[index] ?? '');
    return answer.ok ? { ok: true, value: { ...acc.value, [question.question]: answer.value } } : answer;
  }, { ok: true, value: {} });
}

export function parsePermissionReply(text: string): PermissionReply {
  const trimmed = text.trim();
  if (ALLOW_RE.test(trimmed)) return { behavior: 'allow' };
  if (DENY_RE.test(trimmed)) return { behavior: 'deny' };
  return { behavior: 'deny', message: trimmed };
}

export function parseActionReply(text: string): ActionReply {
  const trimmed = normalizeDigits(text).trim();
  if (PIN_RE.test(trimmed)) return { kind: 'pin', pin: trimmed };
  if (ACTION_DENY_RE.test(trimmed)) return { kind: 'deny' };
  return { kind: 'unknown' };
}

export function parseCommand(text: string): Command | null {
  const trimmed = normalizeDigits(text).trim();
  const simple = SIMPLE_COMMAND_RE.exec(trimmed)?.[1];
  const name = simple ? SIMPLE_COMMANDS[simple.toLowerCase()] : undefined;
  if (name) return { name };
  const todo = TODO_ADD_RE.exec(text.trim());
  if (todo && todo[1]!.trim() !== '') return { name: 'todo_add', text: todo[1]!.trim() };
  const login = LOGIN_COMMAND_RE.exec(trimmed);
  if (login) return { name: 'login', arg: login[1] ?? null };
  const wispr = WISPR_COMMAND_RE.exec(trimmed);
  if (wispr) return { name: 'wispr', arg: wispr[1] ?? null };
  const mute = MUTE_COMMAND_RE.exec(trimmed);
  if (mute) return { name: 'mute', arg: mute[1]?.toLowerCase() ?? null };
  const fresh = NEW_COMMAND_RE.exec(trimmed);
  if (fresh) {
    const [, server, project, task] = NEW_ARGS_RE.exec((fresh[1] ?? '').trim()) ?? [];
    return server && project && task
      ? { name: 'new', server: server.toLowerCase(), project, task: task.trim() }
      : { name: 'new', server: null, project: null, task: null };
  }
  const local = LOCAL_COMMAND_RE.exec(trimmed);
  if (!local) return null;
  const qid = (local[1] ?? '').replace(/^#/, '').toUpperCase();
  return { name: 'local', qid: QID_RE.test(qid) ? qid : null };
}

export function soleSimpleQuestion(pending: readonly QuestionDTO[]): QuestionDTO | null {
  const questions = pending.filter((q) => q.kind === 'question');
  const only = questions.length === 1 ? questions[0] : undefined;
  return only && only.questions.length === 1 ? only : null;
}
