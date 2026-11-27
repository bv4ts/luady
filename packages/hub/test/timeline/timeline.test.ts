import { describe, expect, it } from 'vitest';
import { TimelineDTOSchema, type SessionDTO } from '@luady/shared';
import { openMemoryDb } from '../../src/db/open.js';
import { createTimelineService, ownerDayRange } from '../../src/timeline/index.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { seedAlert, seedCard, seedEvent, seedMeeting, seedNotice, seedQuestion, seedSession } from './seed.js';

const SID = 'birch:cc-checkout:0.0';

function setup(live: Partial<Record<string, Pick<SessionDTO, 'displayName'>>> = {}) {
  const db = openMemoryDb();
  const timeline = createTimelineService({
    db, clock: createFakeClock('2026-11-15T12:00:00.000Z'), log: silentLogger(),
    sessions: { get: (id) => (live[id] === undefined ? undefined : ({ ...live[id] } as SessionDTO)) },
  });
  return { db, timeline };
}

describe('owner days', () => {
  it('an owner day starts at 8 PM UTC the evening before', () => {
    expect(ownerDayRange('2026-11-15')).toEqual({ from: '2026-11-14T20:00:00.000Z', to: '2026-11-15T20:00:00.000Z' });
    expect(ownerDayRange('2027-01-01')).toEqual({ from: '2026-12-31T20:00:00.000Z', to: '2027-01-01T20:00:00.000Z' });
    expect(() => ownerDayRange('2026-02-30')).toThrow(/Not a day/);
  });
});

describe('the today strip', () => {
  it('collects cards, questions, sessions, meetings and alerts of one day, oldest first, in the owner\'s words', () => {
    const t = setup();
    seedSession(t.db, SID, 'birch', 'checkout');
    seedCard(t.db, 'Fix the total', '2026-11-15T03:00:00.000Z', { startedAt: '2026-11-15T04:00:00.000Z', doneAt: '2026-11-15T06:00:00.000Z', server: 'birch' });
    seedQuestion(t.db, 'ABCDEFGH', SID, 'birch', 'Which DB?', '2026-11-15T04:30:00.000Z', '2026-11-15T04:40:00.000Z');
    seedEvent(t.db, 'e1', 'birch', SID, 'session_start', '2026-11-15T03:50:00.000Z', { source: 'startup', model: 'opus' });
    seedEvent(t.db, 'e2', 'birch', SID, 'session_start', '2026-11-15T05:00:00.000Z', { source: 'compact', model: 'opus' });
    seedEvent(t.db, 'e3', 'birch', SID, 'session_end', '2026-11-15T05:10:00.000Z', { reason: 'clear' });
    seedEvent(t.db, 'e4', 'birch', SID, 'session_end', '2026-11-15T07:00:00.000Z', { reason: 'logout' });
    seedEvent(t.db, 'e5', 'hq', 'hq:manager:0.0', 'session_start', '2026-11-15T03:00:00.000Z', { source: 'startup', model: 'opus' });
    seedMeeting(t.db, 'meet-1', 'Weekly sync', '2026-11-15T05:30:00.000Z', '2026-11-15T06:00:00.000Z');
    seedMeeting(t.db, 'meet-2', 'Junk', '2026-11-15T05:31:00.000Z', '2026-11-15T05:32:00.000Z', 'skipped');
    seedAlert(t.db, 'n1', 'checkout stopped unexpectedly', '2026-11-15T07:05:00.000Z', { kind: 'session', id: SID });
    seedNotice(t.db, 'n2', 'result', 'A result, not an alert', '2026-11-15T07:06:00.000Z');
    const day = TimelineDTOSchema.parse(t.timeline.day('2026-11-15'));
    expect(day.items.map((item) => [item.kind, item.label, item.server])).toEqual([
      ['arrived', 'checkout arrived', 'birch'],
      ['started', 'Fix the total', 'birch'],
      ['asked', 'checkout asked: Which DB?', 'birch'],
      ['answered', 'checkout got its answer', 'birch'],
      ['meeting', 'Weekly sync', null],
      ['done', 'Fix the total', 'birch'],
      ['left', 'checkout left', 'birch'],
      ['alert', 'checkout stopped unexpectedly', 'birch'],
    ]);
    expect(day.items[1]?.ref).toEqual({ kind: 'todo', id: '1' });
    expect(day.items[4]?.ref).toEqual({ kind: 'note', id: 'm:meet-1' });
    expect(day.items[7]?.ref).toEqual({ kind: 'session', id: SID });
    expect(JSON.stringify(day.items.map((item) => item.label))).not.toContain(SID);
  });

  it('keeps to the owner day at both midnights', () => {
    const t = setup();
    seedAlert(t.db, 'before', 'late on the 14th', '2026-11-14T19:59:59.999Z');
    seedAlert(t.db, 'first', 'just after midnight', '2026-11-14T20:00:00.000Z');
    seedAlert(t.db, 'last', 'just before midnight', '2026-11-15T19:59:59.999Z');
    seedAlert(t.db, 'after', 'early on the 16th', '2026-11-15T20:00:00.000Z');
    expect(t.timeline.day('2026-11-15').items.map((item) => item.label)).toEqual(['just after midnight', 'just before midnight']);
    expect(t.timeline.day('2026-11-14').items.map((item) => item.label)).toEqual(['late on the 14th']);
    expect(t.timeline.day('2026-11-16').items.map((item) => item.label)).toEqual(['early on the 16th']);
  });

  it('names a session by its live name, else its stored name, never its id; cuts labels to 160', () => {
    const t = setup({ [SID]: { displayName: 'checkout-v2' } });
    seedEvent(t.db, 'e1', 'birch', SID, 'session_start', '2026-11-15T03:50:00.000Z', { source: 'startup', model: 'opus' });
    seedEvent(t.db, 'e2', 'cedar', 'cedar:gone:0.0', 'session_start', '2026-11-15T03:51:00.000Z', { source: 'resume', model: 'opus' });
    seedAlert(t.db, 'n1', 'x'.repeat(300), '2026-11-15T04:00:00.000Z');
    const items = t.timeline.day('2026-11-15').items;
    expect(items.map((item) => item.label.slice(0, 30))).toEqual(['checkout-v2 arrived', 'A session arrived', 'x'.repeat(30)]);
    expect(items[2]?.label).toHaveLength(160);
  });

  it('a permission request reads as one', () => {
    const t = setup();
    seedSession(t.db, SID, 'birch', 'checkout');
    t.db.prepare(`INSERT INTO questions (qid, kind, host, session_id, payload_json, state, created_at)
      VALUES ('BCDEFGHI', 'permission', 'birch', ?, '{"toolName":"Bash"}', 'pending', '2026-11-15T04:00:00.000Z')`).run(SID);
    expect(t.timeline.day('2026-11-15').items.map((item) => item.label)).toEqual(['checkout asked for permission']);
  });

  it('a very busy day keeps its latest 400 marks, oldest first', () => {
    const t = setup();
    for (let i = 0; i < 410; i += 1) seedAlert(t.db, `n${i}`, `alert ${i}`, new Date(Date.parse('2026-11-15T00:00:00.000Z') + i * 60_000).toISOString());
    const items = t.timeline.day('2026-11-15').items;
    expect(items).toHaveLength(400);
    expect(items[0]?.label).toBe('alert 10');
    expect(items.at(-1)?.label).toBe('alert 409');
  });
});
