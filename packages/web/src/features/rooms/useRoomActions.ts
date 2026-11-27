import type { RoomCreateBody, RoomDeleteBody, RoomDTO, RoomUpdateBody, RoomWarning, RoomWriteDTO } from '@luady/shared';
import { useMemo } from 'react';
import { useApi } from '../../api/context.js';
import { reportError } from '../../lib/report.js';
import { usePin } from '../../pin/PinProvider.js';
import { useStore } from '../../state/store.js';
import { roomLookup } from './room-lookup.js';
import { roomProblem, type RoomProblem } from './room-errors.js';

/** A room write's outcome: done (with the room and what to know), cancelled (a PIN prompt closed), or refused. */
export type RoomResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: RoomProblem | null };

/** A write warning in words: a colour close to another, or matches that other rooms have too. */
export function warningWords(warning: RoomWarning, nameOf: (room: string) => string): string {
  switch (warning.kind) {
    case 'near-reserved': return 'Its colour is close to one the office uses for alerts or HQ; pick another if it is hard to tell apart.';
    case 'near-room': return `Its colour is close to ${warning.room === null ? 'another room' : nameOf(warning.room)}; pick another if they are hard to tell apart.`;
    case 'overlap': return `${warning.room === null ? 'Another room' : nameOf(warning.room)} matches some of the same projects; the more exact match wins.`;
  }
}

async function attempt<T>(work: () => Promise<T>, what: string): Promise<RoomResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (err) {
    reportError(what, err);
    return { ok: false, problem: roomProblem(err) };
  }
}

export interface RoomActions {
  create(body: RoomCreateBody): Promise<RoomResult<RoomWriteDTO>>;
  update(id: string, body: RoomUpdateBody): Promise<RoomResult<RoomWriteDTO>>;
  /** Every room id in the new order (positions become 0..n-1). */
  order(ids: readonly string[]): Promise<RoomResult<readonly RoomDTO[]>>;
  move(id: string, position: number): Promise<RoomResult<readonly RoomDTO[]>>;
  /** Asks for the PIN only when the hub says it needs one (a Jira board would be disconnected). */
  remove(id: string, body: RoomDeleteBody): Promise<RoomResult<true>>;
  /** The rooms as the hub has them now (after a stale write), into the store. */
  refresh(): Promise<RoomResult<readonly RoomDTO[]>>;
}

/**
 * The room writes, each followed at once by the store (the map moves before `rooms.changed` arrives) and a short
 * toast; a refusal comes back as words for the form to show.
 */
export function useRoomActions(): RoomActions {
  const api = useApi();
  const { dispatch, toast, state } = useStore();
  const { runPinned } = usePin();
  const rooms = state.rooms;
  return useMemo<RoomActions>(() => {
    const nameOf = (id: string): string => roomLookup(rooms).roomName(id);
    const saved = (result: RoomWriteDTO, verb: string): RoomWriteDTO => {
      dispatch({ type: 'room.saved', room: result.room });
      const notes = result.warnings.map((warning) => warningWords(warning, nameOf));
      toast(notes.length === 0 ? 'success' : 'info', [`${result.room.name} ${verb}.`, ...notes].join(' '));
      return result;
    };
    const listed = (list: readonly RoomDTO[]): readonly RoomDTO[] => {
      dispatch({ type: 'rooms.loaded', rooms: list });
      return list;
    };
    return {
      create: (body) => attempt(async () => saved(await api.createRoom(body), 'is on the map'), 'room create'),
      update: (id, body) => attempt(async () => saved(await api.updateRoom(id, body), 'is saved'), 'room update'),
      order: (ids) => attempt(async () => listed((await api.orderRooms(ids)).items), 'room order'),
      move: (id, position) => attempt(async () => listed((await api.moveRoom(id, position)).items), 'room move'),
      refresh: () => attempt(async () => listed((await api.rooms()).items), 'rooms load'),
      remove: async (id, body) => {
        const name = nameOf(id);
        try {
          const done = await runPinned((pin) => api.deleteRoom(id, pin === undefined ? body : { ...body, pin }), {
            title: `Remove ${name}`, detail: 'Removing this room disconnects its Jira board.', require: false,
          });
          if (done === null) return { ok: false, problem: null };
          dispatch({ type: 'room.removed', id });
          toast('success', `${name} is removed. Its sessions stay; they move to another room or to "Not on the map".`);
          return { ok: true, value: true };
        } catch (err) {
          reportError('room remove', err);
          return { ok: false, problem: roomProblem(err) };
        }
      },
    };
  }, [api, dispatch, toast, runPinned, rooms]);
}
