import { describe, expect, it } from 'vitest';
import { IDLE, dropOf, dropTargetOf, reduceDrag, type DragState } from '../../../../src/features/agency/give/drag.js';
import { session } from '../../../fixtures.js';
import { classicRoomDtos, roomDto } from '../../../room-fixtures.js';

const load = { what: [{ kind: 'todo' as const, id: 12 }], label: '"Fix login"' };
const SESSIONS = [
  session({ id: 'birch:web:0.0', host: 'birch', state: 'working' }),
  session({ id: 'birch:old:0.0', host: 'birch', state: 'ended' }),
  session({ id: 'hq:brain:0.0', host: 'hq', state: 'working' }),
];
/** The classic four as rooms: a drop on a room starts a session on that room's host. */
const ROOMS = classicRoomDtos();
const press = (state: DragState = IDLE) => reduceDrag(state, { type: 'press', load, pointerId: 1, x: 100, y: 100 });
const move = (state: DragState, x: number, y: number, target: Parameters<typeof dropTargetOf>[0] = null, pointerId = 1) =>
  reduceDrag(state, { type: 'move', pointerId, x, y, target });

describe('the drag state machine', () => {
  it('start: a press waits; a small move is still a tap; past the slop it drags', () => {
    const pressed = press();
    expect(pressed.phase).toBe('pressed');
    expect(move(pressed, 103, 102)).toBe(pressed);
    const dragging = move(pressed, 120, 100);
    expect(dragging).toMatchObject({ phase: 'dragging', x: 120, y: 100, target: null });
    expect(dropOf(pressed, SESSIONS, ROOMS)).toBeNull();
  });

  it('hint: the target follows the pointer and an unchanged move keeps the state', () => {
    const dragging = move(press(), 130, 100);
    const over = move(dragging, 140, 110, { kind: 'room', room: 'birch' });
    expect(over).toMatchObject({ target: { kind: 'room', room: 'birch' } });
    expect(move(over, 140, 110, { kind: 'room', room: 'birch' })).toBe(over);
    expect(move(over, 150, 110, { kind: 'room', room: 'birch' })).toMatchObject({ x: 150, target: over.phase === 'dragging' ? over.target : null });
  });

  it('drop on a character gives it to that session; on Luady it lets him decide', () => {
    const onAgent = move(move(press(), 130, 100), 200, 200, { kind: 'actor', id: 'birch:web:0.0' });
    expect(dropOf(onAgent, SESSIONS, ROOMS)).toEqual({ load, to: { kind: 'session', id: 'birch:web:0.0' } });
    const onLuady = move(move(press(), 130, 100), 200, 200, { kind: 'actor', id: 'manager' });
    expect(dropOf(onLuady, SESSIONS, ROOMS)).toEqual({ load, to: { kind: 'auto' } });
  });

  it('drop on a room starts a new session there; HQ and its fixtures mean Luady decides', () => {
    const onRoom = move(move(press(), 130, 100), 200, 200, { kind: 'room', room: 'cedar' });
    expect(dropOf(onRoom, SESSIONS, ROOMS)).toEqual({ load, to: { kind: 'server', server: 'cedar' } });
    expect(dropTargetOf({ kind: 'room', room: 'hq' }, SESSIONS, ROOMS)?.to).toEqual({ kind: 'auto' });
    expect(dropTargetOf({ kind: 'fixture', id: 'rack-ash' }, SESSIONS, ROOMS)).toEqual({ hint: { kind: 'room', room: 'ash' }, to: { kind: 'server', server: 'ash' } });
    expect(dropTargetOf({ kind: 'fixture', id: 'board-hq' }, SESSIONS, ROOMS)?.to).toEqual({ kind: 'auto' });
  });

  it('any room with a host takes work for that host; a lot or a room of any host takes none', () => {
    const rooms = [...ROOMS, roomDto({ id: 'mars', host: 'red-box', position: 7 }), roomDto({ id: 'web', kind: 'project', host: null, position: 8 })];
    expect(dropTargetOf({ kind: 'room', room: 'mars' }, SESSIONS, rooms)).toEqual({ hint: { kind: 'room', room: 'mars' }, to: { kind: 'server', server: 'red-box' } });
    expect(dropTargetOf({ kind: 'fixture', id: 'links-mars' }, SESSIONS, rooms)?.to).toEqual({ kind: 'server', server: 'red-box' });
    expect(dropTargetOf({ kind: 'room', room: 'web' }, SESSIONS, rooms)).toBeNull();
    expect(dropTargetOf({ kind: 'room', room: 'lot-5' }, SESSIONS, rooms)).toBeNull();
  });

  it('drop on nothing (or on something no work can go to) sends nothing', () => {
    const nowhere = move(move(press(), 130, 100), 200, 200, null);
    expect(dropOf(nowhere, SESSIONS, ROOMS)).toBeNull();
    expect(dropTargetOf({ kind: 'room', room: 'lot-1' }, SESSIONS, ROOMS)).toBeNull();
    expect(dropTargetOf({ kind: 'actor', id: 'birch:old:0.0' }, SESSIONS, ROOMS)).toBeNull();
    expect(dropTargetOf({ kind: 'actor', id: 'hq:brain:0.0' }, SESSIONS, ROOMS)).toBeNull();
    expect(dropTargetOf({ kind: 'actor', id: 'gone' }, SESSIONS, ROOMS)).toBeNull();
  });

  it('cancel and release end the drag; another pointer is ignored; a second press while busy is ignored', () => {
    const dragging = move(press(), 130, 100);
    expect(reduceDrag(dragging, { type: 'cancel' })).toBe(IDLE);
    expect(reduceDrag(dragging, { type: 'release', pointerId: 2 })).toBe(dragging);
    expect(reduceDrag(dragging, { type: 'release', pointerId: 1 })).toBe(IDLE);
    expect(move(dragging, 300, 300, null, 2)).toBe(dragging);
    expect(press(dragging)).toBe(dragging);
    expect(move(IDLE, 1, 1)).toBe(IDLE);
  });
});
