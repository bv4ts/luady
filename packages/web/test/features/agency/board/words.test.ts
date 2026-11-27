import { describe, expect, it } from 'vitest';
import { HQ_PALETTE, MUTE_PALETTE } from '@luady/office';
import { cardPalette, cardsLabel, needsReason, officeName, runningLine, sessionPalette, sourceLink } from '../../../../src/features/agency/drawers/board/card-words.js';
import { roomLookup } from '../../../../src/features/rooms/room-lookup.js';
import { clockTime, whenText } from '../../../../src/features/agency/drawers/board/when.js';
import { editBody } from '../../../../src/features/agency/drawers/board/CardFields.js';
import { newCardBody } from '../../../../src/features/agency/drawers/board/AddCard.js';
import { togglePick } from '../../../../src/features/agency/drawers/board/BoardModal.js';
import { question, session } from '../../../fixtures.js';
import { card } from './board-fixtures.js';
import { classicRoomDtos, roomDto } from '../../../room-fixtures.js';

const ROOMS = classicRoomDtos();
const LOOKUP = roomLookup(ROOMS);

describe('times', () => {
  it('reads owner times in 12-hour form', () => {
    const now = Date.parse('2026-11-15T12:00:00.000Z');
    expect(clockTime('2026-11-15T11:20:00.000Z')).toBe('3:20 PM');
    expect(whenText('2026-11-15T05:05:00.000Z', now)).toBe('9:05 AM');
    expect(whenText('2026-11-14T05:05:00.000Z', now)).toBe('Yesterday, 9:05 AM');
    expect(whenText('2026-11-10T05:05:00.000Z', now)).toBe('Nov 10, 9:05 AM');
    expect(whenText(null, now)).toBe('');
    expect(clockTime('nonsense')).toBeNull();
  });
});

describe('card words', () => {
  it('names the office and its colour', () => {
    expect(officeName('ash', LOOKUP)).toBe('Harbor');
    expect(officeName(null, LOOKUP)).toBeNull();
    // By design: a card's colour is its room's palette.
    expect(cardPalette({ server: 'birch' }, LOOKUP)).toEqual({ base: '#d6336c', accent: '#74b816' });
    expect(cardPalette({ server: 'cedar' }, LOOKUP)).toEqual({ base: '#12b886', accent: '#c3fae8' });
    expect(cardPalette({ server: null }, LOOKUP)).toEqual(MUTE_PALETTE);
  });

  it('names any room, never undefined; a session takes the colours of the room it sits in', () => {
    const rooms = [...ROOMS, roomDto({ id: 'mars', name: 'Mars', host: 'mars', position: 6 })];
    expect(officeName('mars', roomLookup(rooms))).toBe('Mars');
    expect(officeName('zeta', roomLookup(rooms))).toBe('zeta');
    expect(sessionPalette(session({ host: 'mars', project: 'x', cwd: null }), rooms)).toEqual({ base: '#3d7bff', accent: '#93b5ff' });
    expect(sessionPalette(session({ host: 'hq', project: null, cwd: null }), rooms)).toEqual(HQ_PALETTE);
    expect(sessionPalette(session({ host: 'zeta', project: null, cwd: null }), rooms)).toEqual(MUTE_PALETTE);
  });

  it('links a source reference to a note, a ticket or a session', () => {
    expect(sourceLink({ source: 'meeting', sourceRef: 'abc' })).toEqual({ kind: 'note', noteId: 'm:abc' });
    expect(sourceLink({ source: 'note', sourceRef: 'n:4' })).toEqual({ kind: 'note', noteId: 'n:4' });
    expect(sourceLink({ source: 'jira', sourceRef: 'birch:ORC-123' })).toEqual({ kind: 'jira', room: 'birch', key: 'ORC-123' });
    expect(sourceLink({ source: 'jira', sourceRef: 'weird' })).toBeNull();
    expect(sourceLink({ source: 'jira', sourceRef: 'site-12:ORC-7' })).toEqual({ kind: 'jira', room: 'site-12', key: 'ORC-7' });
    expect(sourceLink({ source: 'session', sourceRef: 'birch:a' })).toEqual({ kind: 'session', sessionId: 'birch:a' });
    expect(sourceLink({ source: 'web', sourceRef: null })).toBeNull();
  });

  it('says why a card needs the owner and what a running card is doing', () => {
    const running = card(1, { state: 'running', sessionId: 's' });
    expect(needsReason(running, session({ state: 'waiting_question' }), question())).toBe('Waiting for your answer');
    expect(needsReason(running, session({ state: 'waiting_permission' }), undefined)).toBe('Waiting for your permission');
    expect(needsReason(running, session({ state: 'error' }), undefined)).toBe('The session failed');
    expect(needsReason(card(2, { state: 'review', result: 'Blocked: no login.' }), undefined, undefined)).toBe('Blocked: no login.');
    expect(needsReason(card(2, { state: 'review' }), undefined, undefined)).toBe('Needs a look from you');
    expect(runningLine(card(3, { state: 'queued' }), undefined)).toBe('Waiting for Luady');
    expect(runningLine(running, session({ displayName: 'web', state: 'working' }))).toBe('web · working');
    expect(runningLine(running, undefined)).toBe('Session ended');
  });

  it('labels what is given: one title in quotes, else a count', () => {
    expect(cardsLabel([card(1, { title: 'Fix login' })])).toBe('"Fix login"');
    expect(cardsLabel([card(1), card(2), card(3)])).toBe('3 cards');
    expect(cardsLabel([card(1, { title: 'x'.repeat(60) })])).toHaveLength(50);
  });
});

describe('form bodies', () => {
  it('a new card needs a title and sends only what was given', () => {
    expect(newCardBody({ title: '  ', details: '', today: false, high: false, server: '' })).toBe('Give the card a title.');
    expect(newCardBody({ title: ' Buy milk ', details: '', today: false, high: false, server: '' })).toEqual({ title: 'Buy milk', source: 'web' });
    expect(newCardBody({ title: 'Ship', details: ' more ', today: true, high: true, server: 'birch' }))
      .toEqual({ title: 'Ship', source: 'web', details: 'more', today: true, priority: 1, server: 'birch' });
  });

  it('an edit sends only the changed fields', () => {
    const base = card(1, { title: 'Old', details: 'Same' });
    expect(editBody(base, 'Old', 'Same')).toEqual({});
    expect(editBody(base, 'New', 'Same')).toEqual({ title: 'New' });
    expect(editBody(base, 'Old', 'Other')).toEqual({ details: 'Other' });
    expect(editBody(base, ' ', 'Same')).toBe('A card needs a title.');
  });

  it('picking toggles and stops at the delegation limit', () => {
    expect(togglePick([1, 2], 2)).toEqual([1]);
    expect(togglePick([1], 3)).toEqual([1, 3]);
    const full = Array.from({ length: 12 }, (_, i) => i + 1);
    expect(togglePick(full, 99)).toBe(full);
  });
});
