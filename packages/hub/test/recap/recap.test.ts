import { describe, expect, it } from 'vitest';
import { RecapDTOSchema, isEmptyRecap, type QuestionDTO } from '@luady/shared';
import { openMemoryDb } from '../../src/db/open.js';
import { createRecapService, recapStart } from '../../src/recap/index.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { seedAlert, seedCard, seedEvent, seedMeeting, seedSession } from '../timeline/seed.js';

const NOW = '2026-11-15T20:30:00.000Z'; // 12:30 AM on Nov 16 in owner time
const SID = 'birch:cc-checkout:0.0';

function question(over: Partial<QuestionDTO> = {}): QuestionDTO {
  return {
    qid: 'ABCDEFGH', kind: 'question', host: 'birch', sessionId: SID, sessionLabel: 'checkout',
    questions: [{ question: 'Which DB?', options: [{ label: 'Postgres' }] }], permission: null, state: 'pending',
    createdAt: '2026-11-15T19:00:00.000Z', resolvedAt: null, resolvedVia: null, ...over,
  };
}

function setup(pending: QuestionDTO[] = []) {
  const db = openMemoryDb();
  const recap = createRecapService({ db, clock: createFakeClock(NOW), log: silentLogger(), questions: { pending: () => pending } });
  return { db, recap };
}

describe('the welcome-back card', () => {
  it('nothing happened: every list empty, the website shows nothing', () => {
    const t = setup();
    const recap = t.recap.recap(new Date('2026-11-15T18:00:00.000Z'));
    expect(RecapDTOSchema.parse(recap)).toMatchObject({ since: '2026-11-15T18:00:00.000Z', until: NOW });
    expect(isEmptyRecap(recap)).toBe(true);
  });

  it('finished cards, alerts, waiting questions, meetings and the counts since then, newest first', () => {
    const t = setup([question(), question({ qid: 'BCDEFGHI', kind: 'permission', questions: [], permission: { toolName: 'Bash', inputPreview: 'ls' }, createdAt: '2026-11-15T19:30:00.000Z' })]);
    seedSession(t.db, SID, 'birch', 'checkout');
    seedCard(t.db, 'Old card', '2026-11-10T00:00:00.000Z', { doneAt: '2026-11-15T17:00:00.000Z' });
    seedCard(t.db, 'Fix the total', '2026-11-15T18:10:00.000Z', { doneAt: '2026-11-15T19:00:00.000Z', server: 'birch', result: 'Shipped in PR 12' });
    seedCard(t.db, 'Add labels', '2026-11-15T18:20:00.000Z', { doneAt: '2026-11-15T20:00:00.000Z', server: 'birch' });
    seedCard(t.db, 'New idea', '2026-11-15T18:30:00.000Z');
    seedAlert(t.db, 'n1', 'checkout stopped unexpectedly', '2026-11-15T19:10:00.000Z', { kind: 'session', id: SID });
    seedMeeting(t.db, 'meet-1', 'Weekly sync', '2026-11-15T18:00:00.000Z', '2026-11-15T18:40:00.000Z');
    seedMeeting(t.db, 'meet-2', 'Old sync', '2026-11-15T10:00:00.000Z', '2026-11-15T11:00:00.000Z');
    seedEvent(t.db, 'e1', 'birch', SID, 'session_start', '2026-11-15T18:05:00.000Z', { source: 'startup', model: 'opus' });
    seedEvent(t.db, 'e2', 'birch', SID, 'session_end', '2026-11-15T20:10:00.000Z', { reason: 'logout' });
    const recap = RecapDTOSchema.parse(t.recap.recap(new Date('2026-11-15T18:00:00.000Z')));
    expect(recap.finished.map((line) => line.text)).toEqual(['Add labels', 'Fix the total: Shipped in PR 12']);
    expect(recap.finished[1]).toMatchObject({ ref: { kind: 'todo', id: '2' }, server: 'birch' });
    expect(recap.failed).toEqual([{ at: '2026-11-15T19:10:00.000Z', text: 'checkout stopped unexpectedly', ref: { kind: 'session', id: SID }, server: 'birch' }]);
    expect(recap.waiting.map((line) => line.text)).toEqual(['checkout asks to use Bash', 'checkout asks: Which DB?']);
    expect(recap.meetings).toEqual([{ at: '2026-11-15T18:40:00.000Z', text: 'Weekly sync · Sara', ref: { kind: 'note', id: 'm:meet-1' }, server: null }]);
    expect(recap.cards).toEqual({ added: 3, done: 2 });
    expect(recap.sessions).toEqual({ started: 1, ended: 1 });
  });

  it('reaches back 7 days at most, never past now; 12 lines a list', () => {
    const now = new Date(NOW);
    expect(recapStart(new Date('2026-10-01T00:00:00.000Z'), now).toISOString()).toBe('2026-11-08T20:30:00.000Z');
    expect(recapStart(new Date('2026-12-01T00:00:00.000Z'), now).toISOString()).toBe(NOW);
    const t = setup();
    for (let i = 0; i < 15; i += 1) seedAlert(t.db, `n${i}`, `alert ${i}`, new Date(Date.parse('2026-11-15T10:00:00.000Z') + i * 60_000).toISOString());
    seedAlert(t.db, 'old', 'eight days ago', '2026-11-07T20:30:00.000Z');
    const recap = t.recap.recap(new Date('2026-10-01T00:00:00.000Z'));
    expect(recap.since).toBe('2026-11-08T20:30:00.000Z');
    expect(recap.failed).toHaveLength(12);
    expect(recap.failed[0]?.text).toBe('alert 14');
  });

  it('counts across the owner midnight the same as any other time', () => {
    const t = setup();
    seedCard(t.db, 'Before midnight', '2026-11-15T19:59:00.000Z', { doneAt: '2026-11-15T19:59:30.000Z' });
    seedCard(t.db, 'After midnight', '2026-11-15T20:00:00.000Z', { doneAt: '2026-11-15T20:00:30.000Z' });
    expect(t.recap.recap(new Date('2026-11-15T19:59:00.000Z')).finished.map((line) => line.text)).toEqual(['After midnight', 'Before midnight']);
    expect(t.recap.recap(new Date('2026-11-15T20:00:00.000Z')).cards).toEqual({ added: 1, done: 1 });
  });
});
