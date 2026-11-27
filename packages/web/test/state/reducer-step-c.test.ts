import type { BoardItemDTO, SessionActivityDTO, WsServerMessage } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { mergeActivity } from '../../src/state/activity.js';
import { initialState, reducer, type AppAction, type AppState } from '../../src/state/reducer.js';

const AT = '2026-11-15T09:00:00.000Z';
const card = (id: number, over: Partial<BoardItemDTO> = {}): BoardItemDTO => ({
  id, title: `Card ${id}`, details: '', project: null, server: null, source: 'web', sourceRef: null, state: 'open', today: false,
  priority: 0, auto: false, runId: null, sessionId: null, result: null, createdAt: AT, updatedAt: AT, doneAt: null, dueAt: null,
  snoozeUntil: null, ...over,
});
const mission = { sessionId: 'birch:a', label: 'birch · a', title: 'Checkout', phase: 'working' as const, turns: 1, note: null, lastText: null, openedAt: AT, idleSince: null };
const ws = (message: WsServerMessage): AppAction => ({ type: 'ws.message', message });
const run = (state: AppState, ...actions: AppAction[]): AppState => actions.reduce(reducer, state);

describe('board, missions and speech state', () => {
  it('starts with an empty, unloaded board, no missions, no speech and every version at 0', () => {
    expect(initialState).toMatchObject({
      board: { cards: {}, loaded: false }, missions: {}, said: { bySession: {}, seq: 0 },
      notesVersion: 0, kbVersion: 0, libraryVersion: 0, jiraVersion: 0,
    });
  });

  it('loads the board, then follows board.updated and board.removed', () => {
    const state = run(initialState,
      { type: 'board.loaded', items: [card(1), card(2)] },
      ws({ type: 'board.updated', items: [card(2, { state: 'running' }), card(3)] }),
      ws({ type: 'board.removed', ids: [1] }));
    expect(state.board.loaded).toBe(true);
    expect(Object.keys(state.board.cards).sort()).toEqual(['2', '3']);
    expect(state.board.cards['2']?.state).toBe('running');
  });

  it('a live card before the first load is kept, and the board stays not loaded', () => {
    const state = run(initialState, ws({ type: 'board.updated', items: [card(5)] }));
    expect(state.board).toMatchObject({ loaded: false, cards: { 5: card(5) } });
  });

  it('loads missions, then follows mission.updated and mission.removed', () => {
    const state = run(initialState,
      { type: 'missions.loaded', items: [mission] },
      ws({ type: 'mission.updated', mission: { ...mission, phase: 'waiting' } }));
    expect(state.missions['birch:a']?.phase).toBe('waiting');
    expect(run(state, ws({ type: 'mission.removed', sessionId: 'birch:a', outcome: 'done', summary: 'Shipped' })).missions).toEqual({});
  });

  it('session.said keeps the newest per session with a growing arrival number; session.removed drops it', () => {
    const said = { type: 'session.said' as const, sessionId: 'birch:a', kind: 'reply' as const, text: 'Done.', truncated: false, at: AT };
    const state = run(initialState, { type: 'said.loaded', items: [{ sessionId: 'cedar:b', kind: 'reply', text: 'Done.', truncated: false, at: AT }] }, ws(said), ws({ ...said, text: 'Again' }));
    expect(state.said.seq).toBe(2);
    expect(state.said.bySession['birch:a']).toEqual({ said: { sessionId: 'birch:a', kind: 'reply', text: 'Again', truncated: false, at: AT }, seq: 2 });
    expect(state.said.bySession['cedar:b']?.seq).toBe(0);
    expect(run(state, ws({ type: 'session.removed', id: 'birch:a' })).said.bySession['birch:a']).toBeUndefined();
  });

  it('the four *.changed messages bump their version counters', () => {
    const state = run(initialState,
      ws({ type: 'notes.changed', at: AT }), ws({ type: 'notes.changed', at: AT }),
      ws({ type: 'kb.changed', at: AT }), ws({ type: 'library.changed', at: AT }), ws({ type: 'jira.changed', room: 'birch', at: AT }));
    expect(state).toMatchObject({ notesVersion: 2, kbVersion: 1, libraryVersion: 1, jiraVersion: 1, accountsVersion: 0 });
  });
});

describe('activity with the optional fields', () => {
  const base: SessionActivityDTO = { sessionId: 'birch:a', tool: 'edit', paused: false, helpers: 1, contextPct: 10, lastStepAt: AT };

  it('a new step title, helper type or turn start counts as a change', () => {
    const prev = { 'birch:a': { ...base, title: 'Editing a.ts', helperTypes: ['Explore'], turnStartedAt: AT } };
    expect(mergeActivity(prev, [{ ...base, title: 'Editing a.ts', helperTypes: ['Explore'], turnStartedAt: AT }])).toBe(prev);
    expect(mergeActivity(prev, [{ ...base, title: 'Editing b.ts', helperTypes: ['Explore'], turnStartedAt: AT }])['birch:a']?.title).toBe('Editing b.ts');
    expect(mergeActivity(prev, [{ ...base, title: 'Editing a.ts', helperTypes: ['Plan'], turnStartedAt: AT }])).not.toBe(prev);
    expect(mergeActivity({ 'birch:a': base }, [base])).toEqual({ 'birch:a': base });
  });
});
