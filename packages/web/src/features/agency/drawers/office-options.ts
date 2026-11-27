import { isSelfHost } from '@luady/shared';
import { useMemo } from 'react';
import { hostChoices, type RoomsSlice } from '../../../state/rooms.js';
import { useStore } from '../../../state/store.js';
import { roomLookup } from '../../rooms/room-lookup.js';
import { compareOffices, officeHosts } from './library/library-model.js';

/** A host a card can be for, with the name the owner knows it by. */
export interface OfficeOption {
  readonly host: string;
  readonly label: string;
}

/**
 * The offices a card or a page can name (drawers' pickers): the hosts of the rooms and the hosts the hub has, in
 * reading order (rooms by slot, then the rest by id), never the manager's own. No fixed list: any number of hosts.
 */
export function officeOptions(state: Pick<RoomsSlice, 'rooms' | 'servers' | 'hosts'>): readonly OfficeOption[] {
  const lookup = roomLookup(state.rooms);
  const hosts = [...officeHosts(lookup), ...hostChoices(state).map((choice) => choice.id)].filter((host) => !isSelfHost(host));
  return [...new Set(hosts)].toSorted(compareOffices(lookup)).map((host) => ({ host, label: lookup.hostLabel(host) }));
}

/** officeOptions from the store, a new list only when the rooms or hosts change. */
export function useOfficeOptions(): readonly OfficeOption[] {
  const { rooms, servers, hosts } = useStore().state;
  return useMemo(() => officeOptions({ rooms, servers, hosts }), [rooms, servers, hosts]);
}

/** True when the value names one of the options (what a picker may send). */
export function isOffice(options: readonly OfficeOption[], value: string): boolean {
  return options.some((option) => option.host === value);
}
