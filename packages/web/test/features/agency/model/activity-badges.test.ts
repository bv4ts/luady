import type { BoardItemDTO, SessionActivityDTO } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import {
  activityCounts, activityRows, helperWords, pillWords, turnWords,
} from '../../../../src/features/agency/model/activity-list.js';
import { boardBadge, boardCounts } from '../../../../src/features/agency/model/hud-badges.js';
import { NOW, activityItem, session } from '../../../fixtures.js';
import { classicRoomDtos } from '../../../room-fixtures.js';
import { AGENTS, agent } from '../agency-fixtures.js';

const ROOMS = classicRoomDtos();

const at = (minutes: number): string => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

function card(id: number, over: Partial<BoardItemDTO> = {}): BoardItemDTO {
  return {
    id, title: `Card ${id}`, details: '', project: null, server: null, source: 'web', sourceRef: null, state: 'open', today: false,
    priority: 0, auto: false, runId: null, sessionId: null, result: null, createdAt: NOW, updatedAt: NOW, doneAt: null, dueAt: null,
    snoozeUntil: null, ...over,
  };
}

describe('activity counts and rows', () => {
  const sessions = [
    ...AGENTS,
    agent('ash', 'harbor-api', { turnStartedAt: at(-30) }),
  ];
  const activity = {
    'birch:app-backend': activityItem({ sessionId: 'birch:app-backend', helpers: 3, title: 'checkout.ts', helperTypes: ['Explore', 'code-reviewer'], turnStartedAt: at(-4) }),
    'ash:harbor-api': activityItem({ sessionId: 'ash:harbor-api', helpers: 1 }),
    // A session that is not working does not count, whatever its record says.
    'birch:jira-1105': activityItem({ sessionId: 'birch:jira-1105', helpers: 2 }),
  };

  it('counts working sessions and the helpers they run', () => {
    expect(activityCounts(sessions, activity)).toEqual({ working: 2, helpers: 4 });
  });

  it('words for the pill', () => {
    expect(pillWords({ working: 7, helpers: 4 })).toBe('7 working · 4 helpers');
    expect(pillWords({ working: 1, helpers: 1 })).toBe('1 working · 1 helper');
    expect(pillWords({ working: 2, helpers: 0 })).toBe('2 working');
    expect(pillWords({ working: 0, helpers: 0 })).toBe('All quiet');
  });

  it('lists every working session with its room, step, turn start and helpers, longest turn first', () => {
    const rows = activityRows(sessions, activity, ROOMS);
    expect(rows.map((row) => row.id)).toEqual(['ash:harbor-api', 'birch:app-backend']);
    expect(rows[1]).toMatchObject({
      name: 'app-backend', room: 'Orchard', palette: { base: '#d6336c', accent: '#74b816' }, step: 'Editing checkout.ts', startedAt: Date.parse(at(-4)),
      helpers: 3, helperTypes: ['Explore', 'code-reviewer'],
    });
    // The hub's own turn start stands in when the live record has none; no title from an older hub.
    expect(rows[0]).toMatchObject({ room: 'Harbor', step: null, startedAt: Date.parse(at(-30)), helperTypes: [] });
  });

  it('the hub sends the bare step title; the row says what the tool does with it', () => {
    const one = (tool: SessionActivityDTO['tool'], title: string) => activityRows(
      [session({ id: 'cedar:x', host: 'cedar', state: 'working' })], { 'cedar:x': activityItem({ sessionId: 'cedar:x', tool, title }) }, ROOMS,
    )[0]?.step;
    expect(one('read', 'src/app.ts')).toBe('Reading src/app.ts');
    expect(one('run', 'npm test')).toBe('Running npm test');
    expect(one('search', '"TODO"')).toBe('Searching "TODO"');
    expect(one('plan', '4 items')).toBe('Planning 4 items');
    expect(one('other', 'mcp__x')).toBe('mcp__x');
  });

  it('says how long a turn has run', () => {
    const now = Date.parse(NOW);
    expect(turnWords(null, now)).toBeNull();
    expect(turnWords(now - 20_000, now)).toBe('just started');
    expect(turnWords(now - 4 * 60_000, now)).toBe('for 4 min');
    expect(turnWords(now - 60 * 60_000, now)).toBe('for 1 h');
    expect(turnWords(now - 72 * 60_000, now)).toBe('for 1 h 12 min');
  });

  it('names helpers by type, with the rest counted', () => {
    expect(helperWords({ helpers: 0, helperTypes: [] })).toBeNull();
    expect(helperWords({ helpers: 2, helperTypes: [] })).toBe('2 helpers');
    expect(helperWords({ helpers: 1, helperTypes: [] })).toBe('1 helper');
    expect(helperWords({ helpers: 2, helperTypes: ['Explore', 'Plan'] })).toBe('Explore, Plan');
    expect(helperWords({ helpers: 5, helperTypes: ['Explore', 'Plan'] })).toBe('Explore, Plan and 3 more');
  });
});

describe('the board badge', () => {
  const now = Date.parse(NOW);
  const sessions = [agent('birch', 'asks', { state: 'waiting_question' }), agent('birch', 'busy'), agent('birch', 'broke', { state: 'error' })];

  it('counts open cards as to do, leaving out snoozed ones', () => {
    const cards = [card(1), card(2), card(3, { snoozeUntil: at(60) }), card(4, { snoozeUntil: at(-60) }), card(5, { state: 'done' })];
    expect(boardCounts(cards, sessions, now)).toEqual({ todo: 3, needs: 0 });
  });

  it('counts review cards and running cards whose session waits or failed as needs you', () => {
    const cards = [
      card(1, { state: 'review' }),
      card(2, { state: 'running', sessionId: 'birch:asks' }),
      card(3, { state: 'running', sessionId: 'birch:busy' }),
      card(4, { state: 'queued', sessionId: 'birch:broke' }),
      card(5, { state: 'running', sessionId: 'gone' }),
    ];
    expect(boardCounts(cards, sessions, now)).toEqual({ todo: 0, needs: 3 });
  });

  it('is to do plus needs you, red while anything needs the owner, absent when there is nothing', () => {
    expect(boardBadge({ todo: 5, needs: 1 })).toEqual({ count: 6, tone: 'alert', words: '5 to do, 1 needs you' });
    expect(boardBadge({ todo: 2, needs: 0 })).toEqual({ count: 2, tone: 'info', words: '2 to do' });
    expect(boardBadge({ todo: 0, needs: 2 })).toEqual({ count: 2, tone: 'alert', words: '2 need you' });
    expect(boardBadge({ todo: 0, needs: 0 })).toBeNull();
  });
});
