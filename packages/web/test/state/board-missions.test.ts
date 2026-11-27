import { describe, expect, it } from 'vitest';
import { EMPTY_BOARD, cardList, loadBoard, removeCards, upsertCards } from '../../src/state/board.js';
import { EMPTY_MISSIONS, loadMissions, removeMission, upsertMission } from '../../src/state/missions.js';
import { initialState, reducer, type AppAction } from '../../src/state/reducer.js';
import { card, mission } from '../features/agency/board/board-fixtures.js';

const ws = (message: Extract<AppAction, { type: 'ws.message' }>['message']): AppAction => ({ type: 'ws.message', message });

describe('the board slice', () => {
  it('load keeps equal cards by reference and drops cards that are gone', () => {
    const first = loadBoard(EMPTY_BOARD, [card(1), card(2)]);
    const second = loadBoard(first, [card(1), card(3)]);
    expect(second.cards['1']).toBe(first.cards['1']);
    expect(Object.keys(second.cards)).toEqual(['1', '3']);
    expect(cardList(second).map((c) => c.id)).toEqual([1, 3]);
  });

  it('board.updated replaces or adds; an empty update changes nothing', () => {
    const base = loadBoard(EMPTY_BOARD, [card(1), card(2)]);
    const next = upsertCards(base, [card(2, { state: 'running' }), card(5)]);
    expect(next.cards['2']?.state).toBe('running');
    expect(next.cards['1']).toBe(base.cards['1']);
    expect(Object.keys(next.cards).sort()).toEqual(['1', '2', '5']);
    expect(upsertCards(base, [])).toBe(base);
  });

  it('board.removed drops the ids; unknown ids change nothing', () => {
    const base = loadBoard(EMPTY_BOARD, [card(1), card(2)]);
    expect(Object.keys(removeCards(base, [1]).cards)).toEqual(['2']);
    expect(removeCards(base, [9])).toBe(base);
  });
});

describe('the missions slice', () => {
  it('mission.updated replaces by session; mission.removed drops it; unknown removes change nothing', () => {
    const base = loadMissions([mission('birch:a'), mission('cedar:b')]);
    const next = upsertMission(base, mission('birch:a', { turns: 9 }));
    expect(next['birch:a']?.turns).toBe(9);
    expect(next['cedar:b']).toBe(base['cedar:b']);
    expect(Object.keys(removeMission(next, 'birch:a'))).toEqual(['cedar:b']);
    expect(removeMission(base, 'nope')).toBe(base);
    expect(upsertMission(EMPTY_MISSIONS, mission('x'))).toEqual({ x: mission('x') });
  });
});

describe('the four live messages through the app reducer', () => {
  it('board.updated, board.removed, mission.updated and mission.removed', () => {
    const state = [
      { type: 'board.loaded', items: [card(1), card(2)] } as AppAction,
      ws({ type: 'board.updated', items: [card(1, { state: 'queued', runId: 'r1' })] }),
      ws({ type: 'board.removed', ids: [2] }),
      ws({ type: 'mission.updated', mission: mission('birch:a') }),
      ws({ type: 'mission.updated', mission: mission('cedar:b') }),
      ws({ type: 'mission.removed', sessionId: 'birch:a', outcome: 'done', summary: 'Shipped.' }),
    ].reduce(reducer, initialState);
    expect(Object.values(state.board.cards).map((c) => [c.id, c.state])).toEqual([[1, 'queued']]);
    expect(Object.keys(state.missions)).toEqual(['cedar:b']);
  });
});
