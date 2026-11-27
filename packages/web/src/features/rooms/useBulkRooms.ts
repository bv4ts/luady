import type { RoomDTO } from '@luady/shared';
import { useCallback, useMemo, useState } from 'react';
import { hostChoices, type HostChoice } from '../../state/rooms.js';
import { useStore } from '../../state/store.js';
import type { RoomProblem } from './room-errors.js';
import { foldName, hasHomeRoom, nameForHost } from './room-form.js';
import { useRoomActions } from './useRoomActions.js';

/** The hosts that have no server or local room yet, in the order the hub lists them. */
export function hostsWithoutRoom(hosts: readonly HostChoice[], rooms: readonly RoomDTO[]): readonly HostChoice[] {
  return hosts.filter((host) => !hasHomeRoom(rooms, host.id, null));
}

/** A free name for a host's room: its own, or with its id after it when another room has that name. */
export function freeNameFor(host: HostChoice, taken: ReadonlySet<string>): string {
  const plain = nameForHost(host);
  return taken.has(foldName(plain)) ? `${plain} (${host.id})`.slice(0, 40) : plain;
}

export interface BulkRooms {
  /** Hosts a room would be made for. */
  readonly waiting: readonly HostChoice[];
  /** The local host when it exists and has no room ("Add this computer"). */
  readonly computer: HostChoice | null;
  readonly busy: boolean;
  readonly problem: RoomProblem | null;
  /** One room per server without one (the local host included), each in the next free slot. */
  createAll(): Promise<number>;
  /** The room of this computer. */
  addComputer(): Promise<boolean>;
}

/**
 * The empty office's offers: a room for each server that has none, or a room for this
 * computer. One after another, so each takes the next colour, creature and slot.
 */
export function useBulkRooms(): BulkRooms {
  const { state } = useStore();
  const actions = useRoomActions();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<RoomProblem | null>(null);
  const { hosts: hostList, servers, rooms } = state;
  const all = useMemo(() => hostChoices({ hosts: hostList, servers }), [hostList, servers]);
  const waiting = useMemo(() => hostsWithoutRoom(all, rooms), [all, rooms]);
  const computer = waiting.find((host) => host.local) ?? null;

  const make = useCallback(async (list: readonly HostChoice[]): Promise<number> => {
    setBusy(true);
    setProblem(null);
    const taken = new Set(rooms.map((room) => foldName(room.name)));
    let made = 0;
    for (const host of list) {
      const name = freeNameFor(host, taken);
      const result = await actions.create({ name, kind: host.local ? 'local' : 'server', host: host.id });
      if (!result.ok) {
        setProblem(result.problem);
        break;
      }
      taken.add(foldName(name));
      made += 1;
    }
    setBusy(false);
    return made;
  }, [actions, rooms]);

  return {
    waiting, computer, busy, problem,
    createAll: () => make(waiting),
    addComputer: async () => (computer === null ? false : (await make([computer])) === 1),
  };
}
