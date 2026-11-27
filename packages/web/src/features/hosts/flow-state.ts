import type { HostDTO, RoomDTO } from '@luady/shared';

/**
 * Where an add-server flow stands, worked out from the host itself, so a page that reloads, or the
 * wizard opened again, goes on where the owner left off.
 */
export type ServerStep = 'details' | 'key' | 'verify' | 'check' | 'kit' | 'room' | 'done';

export const SERVER_STEPS: ReadonlyArray<{ readonly id: Exclude<ServerStep, 'done'>; readonly label: string }> = [
  { id: 'details', label: 'Details' },
  { id: 'key', label: 'Key line' },
  { id: 'verify', label: 'Fingerprint' },
  { id: 'check', label: 'Check' },
  { id: 'kit', label: 'Kit' },
  { id: 'room', label: 'Room' },
];

export function hasHomeRoom(rooms: readonly RoomDTO[], host: string): boolean {
  return rooms.some((room) => room.host === host && (room.kind === 'server' || room.kind === 'local'));
}

/** The first step still to do for this host. */
export function resumeStep(host: HostDTO, rooms: readonly RoomDTO[]): ServerStep {
  if (host.state !== 'pinned') return 'key';
  if (host.kitVersion === null) return 'check';
  return hasHomeRoom(rooms, host.id) ? 'done' : 'room';
}

/** A server added on the website whose flow is not finished (the one to offer to continue). */
export function unfinishedServer(hosts: readonly HostDTO[], rooms: readonly RoomDTO[]): HostDTO | null {
  return hosts.find((host) => host.kind === 'ssh' && host.source === 'web' && resumeStep(host, rooms) !== 'done') ?? null;
}

/** A host's state in a few words: what the list shows. */
export function hostStateText(host: HostDTO): string {
  if (host.state === 'draft') return 'Not confirmed yet';
  if (host.lastError === 'auth') return 'Key refused';
  if (host.lastError === 'hostkey') return 'Fingerprint changed';
  if (host.link === 'online') return host.kitVersion === null ? 'Connected, no kit' : 'Ready';
  return host.link === 'connecting' ? 'Connecting' : 'Offline';
}
