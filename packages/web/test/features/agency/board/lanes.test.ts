import type { BoardItemDTO } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import {
  buildLanes, canPick, compareTodo, laneOf, ownSessionsRunning, sessionNeedsOwner, sessionsById,
} from '../../../../src/features/agency/drawers/board/lanes.js';
import { session } from '../../../fixtures.js';
import { NOW, card } from './board-fixtures.js';

const DAY = 86_400_000;
const at = (ms: number): string => new Date(NOW + ms).toISOString();
const S = 'birch:app-backend:0.0';
const sessions = (state: Parameters<typeof session>[0] = {}) => sessionsById([session({ id: S, host: 'birch', ...state })]);

describe('laneOf', () => {
  it('puts every state in its lane', () => {
    const live = sessions({ state: 'working' });
    expect(laneOf(card(1), live, NOW)).toBe('todo');
    expect(laneOf(card(2, { state: 'queued' }), live, NOW)).toBe('running');
    expect(laneOf(card(3, { state: 'running', sessionId: S }), live, NOW)).toBe('running');
    expect(laneOf(card(4, { state: 'review' }), live, NOW)).toBe('needs');
    expect(laneOf(card(5, { state: 'done', doneAt: at(-DAY) }), live, NOW)).toBe('done');
  });

  it('a running card whose session waits on the owner or failed goes to Needs you', () => {
    const running = card(3, { state: 'running', sessionId: S });
    expect(laneOf(running, sessions({ state: 'waiting_question' }), NOW)).toBe('needs');
    expect(laneOf(running, sessions({ state: 'waiting_permission' }), NOW)).toBe('needs');
    expect(laneOf(running, sessions({ state: 'error' }), NOW)).toBe('needs');
    expect(laneOf(running, sessions({ state: 'ended', unexpectedEnd: true }), NOW)).toBe('needs');
    expect(laneOf(running, sessions({ state: 'ended', unexpectedEnd: false }), NOW)).toBe('running');
    expect(laneOf(running, sessions({ state: 'idle' }), NOW)).toBe('running');
    expect(laneOf(running, {}, NOW)).toBe('running');
  });

  it('hides snoozed cards until their time and done cards after 14 days', () => {
    expect(laneOf(card(1, { snoozeUntil: at(DAY) }), {}, NOW)).toBeNull();
    expect(laneOf(card(1, { snoozeUntil: at(-1) }), {}, NOW)).toBe('todo');
    expect(laneOf(card(2, { state: 'done', doneAt: at(-15 * DAY) }), {}, NOW)).toBeNull();
    expect(laneOf(card(2, { state: 'done', doneAt: null, updatedAt: at(-13 * DAY) }), {}, NOW)).toBe('done');
  });
});

describe('ordering', () => {
  it('To do: today first, then high priority, then newest', () => {
    const cards: BoardItemDTO[] = [
      card(1, { createdAt: at(-5000) }),
      card(2, { createdAt: at(-1000) }),
      card(3, { priority: 1, createdAt: at(-9000) }),
      card(4, { today: true, createdAt: at(-9000) }),
      card(5, { today: true, priority: 1, createdAt: at(-9500) }),
    ];
    expect(cards.toSorted(compareTodo).map((c) => c.id)).toEqual([5, 4, 3, 2, 1]);
  });

  it('builds the four lanes in order and counts snoozed cards; Done newest first', () => {
    const lanes = buildLanes([
      card(1), card(2, { today: true }), card(3, { snoozeUntil: at(DAY) }),
      card(4, { state: 'running', sessionId: S, updatedAt: at(-10) }), card(5, { state: 'queued', updatedAt: at(-5) }),
      card(6, { state: 'review' }),
      card(7, { state: 'done', doneAt: at(-DAY) }), card(8, { state: 'done', doneAt: at(-60) }),
    ], sessions({ state: 'working' }), NOW);
    expect(lanes.todo.map((c) => c.id)).toEqual([2, 1]);
    expect(lanes.running.map((c) => c.id)).toEqual([5, 4]);
    expect(lanes.needs.map((c) => c.id)).toEqual([6]);
    expect(lanes.done.map((c) => c.id)).toEqual([8, 7]);
    expect(lanes.snoozed).toBe(1);
  });
});

describe('helpers', () => {
  it('only open and review cards can be picked for Run', () => {
    expect(['open', 'queued', 'running', 'review', 'done'].map((state) => canPick(card(1, { state: state as BoardItemDTO['state'] })))).toEqual([true, false, false, true, false]);
  });

  it('counts the owner\'s own live sessions that no running card holds', () => {
    const list = [
      session({ id: 'a', origin: 'owner', state: 'working' }),
      session({ id: 'b', origin: 'owner', state: 'idle' }),
      session({ id: 'c', origin: 'manager', state: 'working' }),
      session({ id: 'd', origin: 'owner', state: 'waiting_question' }),
      session({ id: 'e', origin: 'owner', state: 'working', host: 'hq' }),
    ];
    expect(ownSessionsRunning(list, [])).toBe(2);
    expect(ownSessionsRunning(list, [card(1, { state: 'running', sessionId: 'a' })])).toBe(1);
    expect(sessionNeedsOwner(undefined)).toBe(false);
  });
});
