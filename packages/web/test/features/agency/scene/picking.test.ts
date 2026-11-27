import { describe, expect, it } from 'vitest';
import { eventForHold, eventForTap, pickAt, targetOf } from '../../../../src/features/agency/scene/picking.js';
import { many, session, snap } from './office-fixtures.js';

const office = snap([session('birch:a'), ...many('cedar', 1)]);
const body = (id: string, x: number, y: number, w = 16, h = 16) => ({ id, x, y, w, h });

describe('pickAt', () => {
  const sit = office.actors['birch:a']!.sit;
  const bodies = [body('birch:a', sit.x, sit.y), body('manager', office.map.spots.luadySit.x, office.map.spots.luadySit.y, 18, 20)];

  it('finds a character by its body and prefers the one in front', () => {
    expect(pickAt(office, bodies, sit.x + 3, sit.y - 10, 1).actor).toBe('birch:a');
    const front = [body('back', 100, 100), body('front', 102, 108)];
    expect(pickAt(office, front, 101, 99, 1).actor).toBe('front');
    expect(pickAt(office, bodies, sit.x + 40, sit.y - 10, 1).actor).toBeNull();
  });

  it('ignores characters when zoomed far out', () => {
    expect(pickAt(office, bodies, sit.x, sit.y - 8, 0.3).actor).toBeNull();
  });

  it('finds a rack, the HQ fixtures and the room around them', () => {
    const rack = office.fixtures.find((f) => f.id === 'rack-cedar')!;
    expect(pickAt(office, [], rack.box.x + 10, rack.box.y + 20, 1)).toMatchObject({ fixture: rack, room: 'cedar' });
    ['board-hq', 'library-hq', 'notes-hq', 'fuse-hq'].forEach((id) => {
      const f = office.fixtures.find((g) => g.id === id)!;
      expect(pickAt(office, [], f.box.x + f.box.w / 2, f.box.y + f.box.h / 2, 1).fixture?.id).toBe(id);
    });
  });

  it('reaches two pixels round a small fixture', () => {
    const fuse = office.fixtures.find((f) => f.id === 'fuse-hq')!;
    expect(pickAt(office, [], fuse.box.x - 2, fuse.box.y, 1).fixture?.id).toBe('fuse-hq');
    expect(pickAt(office, [], fuse.box.x + fuse.box.w + 3, fuse.box.y + 10, 1).fixture).toBeNull();
  });

  it('finds a Jira board only in a room that has one', () => {
    const withJira = snap([], { jiraRooms: ['birch'] });
    const jira = withJira.fixtures.find((f) => f.id === 'jira-birch')!;
    expect(pickAt(withJira, [], jira.box.x + 5, jira.box.y + 5, 1).fixture?.id).toBe('jira-birch');
    expect(pickAt(office, [], jira.box.x + 5, jira.box.y + 5, 1).fixture).toBeNull();
  });

  it('finds the room floor and nothing outside the building', () => {
    expect(pickAt(office, [], 200, 150, 1)).toEqual({ actor: null, fixture: null, room: 'birch' });
    expect(pickAt(office, [], -50, -50, 1)).toEqual({ actor: null, fixture: null, room: null });
  });
});

describe('eventForTap / eventForHold', () => {
  const rack = office.fixtures.find((f) => f.id === 'rack-cedar')!;
  const board = office.fixtures.find((f) => f.id === 'board-hq')!;

  it('maps a tap to an actor, then a fixture (before its room), a room or the outside', () => {
    expect(eventForTap({ actor: 'birch:a', fixture: rack, room: 'birch' })).toEqual({ type: 'actor', id: 'birch:a' });
    expect(eventForTap({ actor: null, fixture: rack, room: 'cedar' })).toEqual({ type: 'fixture', fixture: 'rack', id: 'rack-cedar', room: 'cedar' });
    expect(eventForTap({ actor: null, fixture: board, room: 'hq' })).toEqual({ type: 'fixture', fixture: 'board', id: 'board-hq', room: 'hq' });
    expect(eventForTap({ actor: null, fixture: null, room: 'ash' })).toEqual({ type: 'room', room: 'ash' });
    expect(eventForTap({ actor: null, fixture: null, room: null })).toEqual({ type: 'room', room: null });
  });

  it('targetOf: a character, else a fixture, else the room, else nothing', () => {
    expect(targetOf({ actor: 'birch:a', fixture: null, room: 'birch' })).toEqual({ kind: 'actor', id: 'birch:a' });
    expect(targetOf({ actor: null, fixture: board, room: 'hq' })).toEqual({ kind: 'fixture', id: 'board-hq' });
    expect(targetOf({ actor: null, fixture: null, room: 'cedar' })).toEqual({ kind: 'room', room: 'cedar' });
    expect(targetOf({ actor: null, fixture: null, room: null })).toBeNull();
  });

  it('opens the menu only for a character', () => {
    expect(eventForHold({ actor: 'cedar:s00', fixture: null, room: 'cedar' }, { x: 5, y: 6 })).toEqual({ type: 'menu', id: 'cedar:s00', x: 5, y: 6 });
    expect(eventForHold({ actor: null, fixture: rack, room: 'cedar' }, { x: 5, y: 6 })).toBeNull();
  });
});
