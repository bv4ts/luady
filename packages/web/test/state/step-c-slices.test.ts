import type { BoardItemDTO, MissionDTO, SaidDTO } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import { EMPTY_BOARD, cardList, loadBoard, removeCards, upsertCards } from '../../src/state/board.js';
import { EMPTY_MISSIONS, loadMissions, removeMission, upsertMission } from '../../src/state/missions.js';
import { EMPTY_SAID, dropSaid, loadSaid, receiveSaid } from '../../src/state/said.js';

const AT = '2026-11-15T09:00:00.000Z';
const LATER = '2026-11-15T09:05:00.000Z';

const card = (id: number, over: Partial<BoardItemDTO> = {}): BoardItemDTO => ({
  id, title: `Card ${id}`, details: '', project: null, server: null, source: 'web', sourceRef: null, state: 'open', today: false,
  priority: 0, auto: false, runId: null, sessionId: null, result: null, createdAt: AT, updatedAt: AT, doneAt: null, dueAt: null,
  snoozeUntil: null, ...over,
});

const mission = (sessionId: string, over: Partial<MissionDTO> = {}): MissionDTO => ({
  sessionId, label: sessionId, title: 'Checkout', phase: 'working', turns: 1, note: null, lastText: null, openedAt: AT, idleSince: null, ...over,
});

const said = (sessionId: string, over: Partial<SaidDTO> = {}): SaidDTO =>
  ({ sessionId, kind: 'reply', text: 'Done.', truncated: false, at: AT, ...over });

describe('board slice', () => {
  it('starts empty and not loaded', () => {
    expect(EMPTY_BOARD).toEqual({ cards: {}, loaded: false });
  });

  it('a load replaces every card and marks the board loaded', () => {
    const first = loadBoard(EMPTY_BOARD, [card(1), card(2)]);
    expect(first.loaded).toBe(true);
    expect(cardList(first).map((c) => c.id)).toEqual([1, 2]);
    const second = loadBoard(first, [card(2)]);
    expect(Object.keys(second.cards)).toEqual(['2']);
    expect(second.cards['2']).toBe(first.cards['2']);
  });

  it('updates add or replace cards and keep the others by reference', () => {
    const base = loadBoard(EMPTY_BOARD, [card(1), card(2)]);
    const next = upsertCards(base, [card(2, { state: 'running' }), card(3)]);
    expect(next.cards['2']?.state).toBe('running');
    expect(next.cards['1']).toBe(base.cards['1']);
    expect(cardList(next).map((c) => c.id)).toEqual([1, 2, 3]);
    expect(base.cards['2']?.state).toBe('open');
    expect(upsertCards(base, [])).toBe(base);
  });

  it('removals drop the cards, and unknown ids change nothing', () => {
    const base = loadBoard(EMPTY_BOARD, [card(1), card(2)]);
    expect(Object.keys(removeCards(base, [1]).cards)).toEqual(['2']);
    expect(removeCards(base, [9])).toBe(base);
  });
});

describe('missions slice', () => {
  it('loads, updates and removes missions by session', () => {
    const loaded = loadMissions([mission('birch:a'), mission('cedar:b')]);
    expect(Object.keys(loaded).sort()).toEqual(['birch:a', 'cedar:b']);
    const moved = upsertMission(loaded, mission('birch:a', { phase: 'waiting' }));
    expect(moved['birch:a']?.phase).toBe('waiting');
    expect(moved['cedar:b']).toBe(loaded['cedar:b']);
    expect(Object.keys(removeMission(moved, 'birch:a'))).toEqual(['cedar:b']);
    expect(removeMission(moved, 'ash:none')).toBe(moved);
    expect(EMPTY_MISSIONS).toEqual({});
  });
});

describe('said slice', () => {
  it('a live message is the newest for its session with an arrival number that only grows', () => {
    const one = receiveSaid(EMPTY_SAID, said('birch:a'));
    expect(one.seq).toBe(1);
    expect(one.bySession['birch:a']).toEqual({ said: said('birch:a'), seq: 1 });
    const two = receiveSaid(one, said('cedar:b'));
    const three = receiveSaid(two, said('birch:a', { kind: 'report', text: '#12 done: shipped', at: LATER }));
    expect(three.seq).toBe(3);
    expect(three.bySession['birch:a']?.seq).toBe(3);
    expect(three.bySession['cedar:b']).toBe(two.bySession['cedar:b']);
  });

  it('a load fills sessions with arrival number 0 (seen before, not new) and never replaces something newer', () => {
    const live = receiveSaid(EMPTY_SAID, said('birch:a', { at: LATER, text: 'live' }));
    const loaded = loadSaid(live, [said('birch:a', { text: 'older' }), said('cedar:b')]);
    expect(loaded.bySession['birch:a']?.said.text).toBe('live');
    expect(loaded.bySession['cedar:b']).toEqual({ said: said('cedar:b'), seq: 0 });
    expect(loaded.seq).toBe(1);
    expect(loadSaid(loaded, [])).toBe(loaded);
  });

  it('drops the speech of a session that left', () => {
    const live = receiveSaid(EMPTY_SAID, said('birch:a'));
    expect(dropSaid(live, 'birch:a').bySession).toEqual({});
    expect(dropSaid(live, 'cedar:none')).toBe(live);
  });
});
