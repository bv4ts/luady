import { describe, expect, it } from 'vitest';
import type { AskQuestion, QuestionDTO } from '@luady/shared';
import {
  isOptionList, looksLikePin, normalizeDigits, parseActionReply, parseCommand, parsePermissionReply, parseQuestionReply,
  soleSimpleQuestion,
} from '../../src/inbound/parse.js';

const DB: AskQuestion = {
  question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }, { label: 'MySQL' }],
};
const FEATURES: AskQuestion = {
  question: 'Which features?', multiSelect: true, options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }],
};

function pending(qid: string, kind: QuestionDTO['kind'], questions: AskQuestion[]): QuestionDTO {
  return {
    qid, kind, host: 'cedar', sessionId: 'cedar:cc-meadow-hr:0.0', sessionLabel: 'meadow-hr', questions,
    permission: kind === 'permission' ? { toolName: 'Bash', inputPreview: 'ls' } : null, state: 'pending',
    createdAt: '2026-10-09T12:00:00.000Z', resolvedAt: null, resolvedVia: null,
  };
}

describe('normalizeDigits', () => {
  it('maps Arabic-Indic and Extended Arabic-Indic digits to ASCII and leaves other text alone', () => {
    expect(normalizeDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(normalizeDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
    expect(normalizeDigits('خيار ٢ please')).toBe('خيار 2 please');
    expect(normalizeDigits('١،٣')).toBe('1,3');
  });

  it('applies to option numbers, PINs and /local while free text keeps the original digits', () => {
    expect(parseQuestionReply('ABCDEFGH', [DB], '٢')).toEqual({ ok: true, value: { 'Which DB?': 'SQLite' } });
    expect(parseQuestionReply('ABCDEFGH', [FEATURES], '١,٣')).toEqual({ ok: true, value: { 'Which features?': 'Auth, Search' } });
    expect(parseActionReply('١٢٣٤٥٦')).toEqual({ kind: 'pin', pin: '123456' });
    expect(looksLikePin('۴۸۲۹۱۳')).toBe(true);
    expect(isOptionList('۲')).toBe(true);
    expect(parseCommand('/local ABCDEFG٢')).toEqual({ name: 'local', qid: 'ABCDEFG2' });
    expect(parseQuestionReply('ABCDEFGH', [DB], 'سأختار ٢ لاحقاً')).toEqual({
      ok: true, value: { 'Which DB?': 'سأختار ٢ لاحقاً' },
    });
  });
});

describe('isOptionList and looksLikePin', () => {
  it('recognises bare option numbers', () => {
    for (const text of ['2', '1,3', ' 1 , 3 ']) expect(isOptionList(text)).toBe(true);
    for (const text of ['2a', '1,', '', 'yes', '1 3']) expect(isOptionList(text)).toBe(false);
  });

  it('recognises 6 to 12 digit PIN shapes only', () => {
    expect(looksLikePin('123456')).toBe(true);
    expect(looksLikePin(' 000123456789 ')).toBe(true);
    expect(looksLikePin('12345')).toBe(false);
    expect(looksLikePin('1234567890123')).toBe(false);
  });
});

describe('parseQuestionReply', () => {
  it('maps a number to the option label, keyed by the exact question text', () => {
    expect(parseQuestionReply('ABCDEFGH', [DB], '2')).toEqual({ ok: true, value: { 'Which DB?': 'SQLite' } });
  });

  it('treats anything else as free text', () => {
    expect(parseQuestionReply('ABCDEFGH', [DB], '  Use CockroachDB ')).toEqual({
      ok: true, value: { 'Which DB?': 'Use CockroachDB' },
    });
  });

  it('answers out-of-range numbers with help', () => {
    expect(parseQuestionReply('ABCDEFGH', [DB], '9')).toEqual({
      ok: false, help: 'ℹ️ #ABCDEFGH: reply with a number from 1 to 3 (1,3 for several), or with your own answer.',
    });
    expect(parseQuestionReply('ABCDEFGH', [DB], '0').ok).toBe(false);
  });

  it('rejects several numbers for a single-choice question', () => {
    expect(parseQuestionReply('ABCDEFGH', [DB], '1,2')).toEqual({
      ok: false, help: 'ℹ️ #ABCDEFGH takes one option — reply with a single number, or with your own answer.',
    });
  });

  it('joins multi-select labels with ", " and ignores repeats', () => {
    expect(parseQuestionReply('ABCDEFGH', [FEATURES], '1, 3')).toEqual({
      ok: true, value: { 'Which features?': 'Auth, Search' },
    });
    expect(parseQuestionReply('ABCDEFGH', [FEATURES], '2,2')).toEqual({ ok: true, value: { 'Which features?': 'Billing' } });
  });

  it('treats numbers as free text when the question has no options', () => {
    const open: AskQuestion = { question: 'How many retries?', options: [] };
    expect(parseQuestionReply('ABCDEFGH', [open], '3')).toEqual({ ok: true, value: { 'How many retries?': '3' } });
  });

  it('takes one non-empty line per question for multi-question prompts', () => {
    expect(parseQuestionReply('ABCDEFGH', [DB, FEATURES], '1\n\n  2,3 \n')).toEqual({
      ok: true, value: { 'Which DB?': 'Postgres', 'Which features?': 'Billing, Search' },
    });
    expect(parseQuestionReply('ABCDEFGH', [DB, FEATURES], 'Postgres please\nAll of them')).toEqual({
      ok: true, value: { 'Which DB?': 'Postgres please', 'Which features?': 'All of them' },
    });
  });

  it('asks for one line per question when the line count is wrong, and reports a bad line', () => {
    expect(parseQuestionReply('ABCDEFGH', [DB, FEATURES], '1')).toEqual({
      ok: false, help: 'ℹ️ #ABCDEFGH has 2 questions — reply with one line per question, in order.',
    });
    expect(parseQuestionReply('ABCDEFGH', [DB, FEATURES], '7\n1').ok).toBe(false);
  });
});

describe('parsePermissionReply', () => {
  it('accepts English and Arabic yes and no', () => {
    for (const text of ['y', 'YES', 'allow', 'Ok', 'نعم']) expect(parsePermissionReply(text)).toEqual({ behavior: 'allow' });
    for (const text of ['n', 'No', 'DENY', 'لا']) expect(parsePermissionReply(text)).toEqual({ behavior: 'deny' });
  });

  it('denies with the text as the message for anything else', () => {
    expect(parsePermissionReply(' not now, run the tests first ')).toEqual({
      behavior: 'deny', message: 'not now, run the tests first',
    });
  });
});

describe('parseActionReply', () => {
  it('reads a PIN, a refusal, or nothing useful', () => {
    expect(parseActionReply(' 123456 ')).toEqual({ kind: 'pin', pin: '123456' });
    for (const text of ['no', 'Cancel', 'لا']) expect(parseActionReply(text)).toEqual({ kind: 'deny' });
    for (const text of ['12345', '1234567890123', 'maybe']) expect(parseActionReply(text)).toEqual({ kind: 'unknown' });
  });
});

describe('parseCommand', () => {
  it('matches the simple commands case-insensitively', () => {
    expect(parseCommand('/status')).toEqual({ name: 'status' });
    expect(parseCommand(' /STATUS ')).toEqual({ name: 'status' });
    for (const name of ['q', 'away', 'back', 'help'] as const) expect(parseCommand(`/${name}`)).toEqual({ name });
    expect(parseCommand('/call')).toBeNull();
  });

  it('parses /local with a normalised qid, or null when it is missing or invalid', () => {
    expect(parseCommand('/local abcdefgh')).toEqual({ name: 'local', qid: 'ABCDEFGH' });
    expect(parseCommand('/LOCAL #ABCDEFGH')).toEqual({ name: 'local', qid: 'ABCDEFGH' });
    expect(parseCommand('/local')).toEqual({ name: 'local', qid: null });
    expect(parseCommand('/local bad!')).toEqual({ name: 'local', qid: null });
  });

  it('returns null for anything that is not exactly a command', () => {
    for (const text of ['/status now', 'status', '/unknown', 'hello /help']) expect(parseCommand(text)).toBeNull();
  });
});

describe('soleSimpleQuestion', () => {
  it('returns the only pending question when it has a single question', () => {
    const only = pending('ABCDEFGH', 'question', [DB]);
    expect(soleSimpleQuestion([only, pending('QRSTUVWX', 'permission', [])])).toBe(only);
  });

  it('returns null for zero, several, or multi-question pending items', () => {
    expect(soleSimpleQuestion([])).toBeNull();
    expect(soleSimpleQuestion([pending('ABCDEFGH', 'question', [DB]), pending('QRSTUVWX', 'question', [DB])])).toBeNull();
    expect(soleSimpleQuestion([pending('ABCDEFGH', 'question', [DB, FEATURES])])).toBeNull();
  });
  it('parses the new commands', () => {
    expect(parseCommand('/missions')).toEqual({ name: 'missions' });
    expect(parseCommand('/Sessions')).toEqual({ name: 'sessions' });
    expect(parseCommand('/reset')).toEqual({ name: 'reset' });
    expect(parseCommand('/today')).toEqual({ name: 'today' });
    expect(parseCommand('/mute 2')).toEqual({ name: 'mute', arg: '2' });
    expect(parseCommand('/mute OFF')).toEqual({ name: 'mute', arg: 'off' });
    expect(parseCommand('/mute')).toEqual({ name: 'mute', arg: null });
    expect(parseCommand('/new birch orchard fix the login loop')).toEqual({ name: 'new', server: 'birch', project: 'orchard', task: 'fix the login loop' });
    expect(parseCommand('/new birch')).toEqual({ name: 'new', server: null, project: null, task: null });
  });

});

describe('/todo next to the other commands', () => {
  it('/todo alone still lists; /todo <text> adds, keeping the words as written', () => {
    expect(parseCommand('/todo')).toEqual({ name: 'todo' });
    expect(parseCommand('  /TODO  ')).toEqual({ name: 'todo' });
    expect(parseCommand('/todo buy milk')).toEqual({ name: 'todo_add', text: 'buy milk' });
    expect(parseCommand('/Todo  اشتري ٢ حليب \n')).toEqual({ name: 'todo_add', text: 'اشتري ٢ حليب' });
    expect(parseCommand('/todo call the bank\nabout the card')).toEqual({ name: 'todo_add', text: 'call the bank\nabout the card' });
  });

  it('does not take other words that start alike, and parses /today and /status as their own commands', () => {
    expect(parseCommand('/todos')).toBeNull();
    expect(parseCommand('/todobuy milk')).toBeNull();
    expect(parseCommand('todo buy milk')).toBeNull();
    expect(parseCommand('/today')).toEqual({ name: 'today' });
    expect(parseCommand('/status')).toEqual({ name: 'status' });
  });
});
