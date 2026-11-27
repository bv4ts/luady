import type { RoomDTO } from '@luady/shared';
import { officeNameIn } from '../../src/library/offices.js';

/**
 * The classic four as rooms, so their office names are data. Tests that read office names (Jira rows,
 * INDEX.md headings, the library order) pass these.
 */
const AT = '2026-11-21T08:00:00.000Z';

const room = (id: string, name: string, host: string, position: number, species: RoomDTO['species']): RoomDTO => ({
  id, name, short: name.slice(0, 12), kind: 'server', host, match: [], colour: '#d6336c', accent: '#ebb2c6', species, position,
  size: 'm', hostState: 'ok', createdAt: AT, updatedAt: AT,
});

/** Rooms keyed by their host id, as the classic offices were: `birch` (Orchard) and so on. */
export const CLASSIC_ROOMS: readonly RoomDTO[] = Object.freeze([
  room('birch', 'Orchard', 'birch', 0, 'bun'),
  room('ash', 'Harbor', 'ash', 1, 'bot'),
  room('cedar', 'Meadow', 'cedar', 2, 'shield'),
  room('local', 'Private Projects', 'local', 3, 'ghost'),
]);

/** The office name of a room id or a host among the classic four. */
export const classicOfficeName = (key: string): string => officeNameIn(CLASSIC_ROOMS, key);
