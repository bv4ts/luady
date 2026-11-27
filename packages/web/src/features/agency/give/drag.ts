import { HQ_ID } from '@luady/office';
import { isSelfHost, type DelegateTo, type DelegateWhat, type RoomDTO, type SessionDTO } from '@luady/shared';
import { LUADY_ACTOR_ID, type StageTarget } from '../stage-types.js';

/** A press on a handle becomes a drag once the pointer moved this far (CSS px); less is a tap. */
export const DRAG_SLOP_PX = 6;

export interface DragLoad {
  readonly what: readonly DelegateWhat[];
  readonly label: string;
}

/**
 * idle → pressed (pointer down on a handle) → dragging (moved past the slop; the pop-up shrinks, a chip follows) → idle
 * on drop or cancel. `target` is what the map has under the pointer, already turned into somewhere work can go.
 */
export type DragState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'pressed'; readonly load: DragLoad; readonly pointerId: number; readonly startX: number; readonly startY: number }
  | {
    readonly phase: 'dragging'; readonly load: DragLoad; readonly pointerId: number;
    readonly x: number; readonly y: number; readonly target: StageTarget | null;
  };

export type DragInput =
  | { readonly type: 'press'; readonly load: DragLoad; readonly pointerId: number; readonly x: number; readonly y: number }
  | { readonly type: 'move'; readonly pointerId: number; readonly x: number; readonly y: number; readonly target: StageTarget | null }
  | { readonly type: 'release'; readonly pointerId: number }
  | { readonly type: 'cancel' };

export const IDLE: DragState = Object.freeze({ phase: 'idle' });

const sameTarget = (a: StageTarget | null, b: StageTarget | null): boolean => {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind === 'room' ? a.room === (b as typeof a).room : a.id === (b as typeof a).id;
};

export function reduceDrag(state: DragState, input: DragInput): DragState {
  switch (input.type) {
    case 'press':
      return state.phase === 'idle'
        ? { phase: 'pressed', load: input.load, pointerId: input.pointerId, startX: input.x, startY: input.y }
        : state;
    case 'move': {
      if (state.phase === 'idle' || input.pointerId !== state.pointerId) return state;
      if (state.phase === 'pressed') {
        const far = Math.hypot(input.x - state.startX, input.y - state.startY) >= DRAG_SLOP_PX;
        return far ? { phase: 'dragging', load: state.load, pointerId: state.pointerId, x: input.x, y: input.y, target: input.target } : state;
      }
      if (state.x === input.x && state.y === input.y && sameTarget(state.target, input.target)) return state;
      return { ...state, x: input.x, y: input.y, target: sameTarget(state.target, input.target) ? state.target : input.target };
    }
    case 'release':
      return state.phase !== 'idle' && input.pointerId === state.pointerId ? IDLE : state;
    case 'cancel':
      return IDLE;
  }
}

/** The room of a fixture id (`${kind}-${room}`). */
const fixtureRoom = (id: string): string => id.slice(id.indexOf('-') + 1);

/** The host a room on the map starts sessions on: the room's own host; null for HQ, a lot, or a room of any host. */
function roomHost(roomKey: string, rooms: readonly RoomDTO[]): string | null {
  const room = rooms.find((candidate) => candidate.id === roomKey);
  return room === undefined || room.host === null || isSelfHost(room.host) ? null : room.host;
}

/**
 * What the map has under the pointer, as somewhere work can go: Luady and HQ mean "Luady decides", a character that is a
 * live session is that session, a room with a host (or a fixture in it) is a new session on that host. Anything else
 * (a lot, a room of any host): null.
 */
export function dropTargetOf(
  target: StageTarget | null, sessions: readonly SessionDTO[], rooms: readonly RoomDTO[],
): { readonly hint: StageTarget; readonly to: DelegateTo } | null {
  if (target === null) return null;
  if (target.kind === 'actor') {
    if (target.id === LUADY_ACTOR_ID) return { hint: target, to: { kind: 'auto' } };
    const session = sessions.find((candidate) => candidate.id === target.id);
    if (session === undefined || session.state === 'ended' || isSelfHost(session.host)) return null;
    return { hint: target, to: { kind: 'session', id: session.id } };
  }
  const room = target.kind === 'room' ? target.room : fixtureRoom(target.id);
  const hint: StageTarget = { kind: 'room', room };
  if (room === HQ_ID) return { hint, to: { kind: 'auto' } };
  const host = roomHost(room, rooms);
  return host === null ? null : { hint, to: { kind: 'server', server: host } };
}

/** Where a drop sends the load; null = it was a tap, or it fell on nothing (nothing is sent). */
export function dropOf(
  state: DragState, sessions: readonly SessionDTO[], rooms: readonly RoomDTO[],
): { readonly load: DragLoad; readonly to: DelegateTo } | null {
  if (state.phase !== 'dragging') return null;
  const drop = dropTargetOf(state.target, sessions, rooms);
  return drop === null ? null : { load: state.load, to: drop.to };
}
