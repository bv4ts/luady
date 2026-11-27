import type { AskQuestion } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_DRAFT, FREE_TEXT_MAX, buildAnswers, buildPermissionAnswer, chooseOther, setOtherText, toggleOption,
} from '../../../src/features/inbox/answer-mapping.js';

const db: AskQuestion = { question: 'Which database?', header: 'Database', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] };
const checks: AskQuestion = { question: 'Which checks should run?', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Tests' }, { label: 'Build' }] };
const free: AskQuestion = { question: 'What should the release be called?', options: [] };

describe('answer mapping', () => {
  it('keys a single-select answer by the exact question text', () => {
    const draft = toggleOption(db, EMPTY_DRAFT, 'SQLite');
    expect(buildAnswers([db], [draft])).toEqual({ ok: true, value: { answers: { 'Which database?': 'SQLite' } } });
  });

  it('replaces the previous choice in a single-select question', () => {
    expect(toggleOption(db, toggleOption(db, EMPTY_DRAFT, 'Postgres'), 'SQLite').selected).toEqual(['SQLite']);
  });

  it('joins multi-select labels with ", " in option order', () => {
    const draft = toggleOption(checks, toggleOption(checks, EMPTY_DRAFT, 'Build'), 'Lint');
    expect(buildAnswers([checks], [draft])).toEqual({ ok: true, value: { answers: { 'Which checks should run?': 'Lint, Build' } } });
    expect(toggleOption(checks, draft, 'Lint').selected).toEqual(['Build']);
  });

  it('sends "Other" free text as-is and clears picked options', () => {
    const picked = toggleOption(checks, EMPTY_DRAFT, 'Tests');
    const other = setOtherText(chooseOther(picked, true), '  only the payroll suite  ');
    expect(other.selected).toEqual([]);
    expect(buildAnswers([checks], [other])).toEqual({ ok: true, value: { answers: { 'Which checks should run?': '  only the payroll suite  ' } } });
    expect(toggleOption(checks, other, 'Lint')).toMatchObject({ useOther: false, selected: ['Lint'] });
  });

  it('maps several questions into one answer body', () => {
    const drafts = [
      toggleOption(db, EMPTY_DRAFT, 'Postgres'),
      toggleOption(checks, toggleOption(checks, EMPTY_DRAFT, 'Tests'), 'Lint'),
      setOtherText(EMPTY_DRAFT, 'v2.4 "Falcon"'),
    ];
    expect(buildAnswers([db, checks, free], drafts)).toEqual({
      ok: true,
      value: { answers: { 'Which database?': 'Postgres', 'Which checks should run?': 'Lint, Tests', 'What should the release be called?': 'v2.4 "Falcon"' } },
    });
  });

  it('names the question that still needs an answer', () => {
    expect(buildAnswers([db, checks], [toggleOption(db, EMPTY_DRAFT, 'SQLite'), EMPTY_DRAFT]))
      .toEqual({ ok: false, error: 'Question 2: Pick at least one option.' });
    expect(buildAnswers([db], [EMPTY_DRAFT])).toEqual({ ok: false, error: 'Pick an option.' });
    expect(buildAnswers([free], [EMPTY_DRAFT])).toEqual({ ok: false, error: 'Type your answer.' });
    expect(buildAnswers([db], [setOtherText(EMPTY_DRAFT, '   ')])).toEqual({ ok: false, error: 'Type your answer.' });
  });

  it('rejects answers the hub would refuse', () => {
    expect(buildAnswers([free], [setOtherText(EMPTY_DRAFT, 'x'.repeat(FREE_TEXT_MAX + 1))]).ok).toBe(false);
    expect(buildAnswers([db, { ...db }], [toggleOption(db, EMPTY_DRAFT, 'SQLite'), toggleOption(db, EMPTY_DRAFT, 'SQLite')]))
      .toEqual({ ok: false, error: 'Question 2: Two questions share the same text. Answer this one in the terminal.' });
  });

  it('keeps unusual question texts as plain own keys', () => {
    const odd: AskQuestion = { question: '__proto__', options: [] };
    const result = buildAnswers([odd], [setOtherText(EMPTY_DRAFT, 'safe')]);
    expect(result.ok && JSON.stringify(result.value)).toBe('{"answers":{"__proto__":"safe"}}');
  });

  it('builds permission decisions', () => {
    expect(buildPermissionAnswer('allow', '   ')).toEqual({ ok: true, value: { behavior: 'allow' } });
    expect(buildPermissionAnswer('deny', '  use the staging database ')).toEqual({ ok: true, value: { behavior: 'deny', message: 'use the staging database' } });
    expect(buildPermissionAnswer('deny', 'x'.repeat(1001)).ok).toBe(false);
  });
});
