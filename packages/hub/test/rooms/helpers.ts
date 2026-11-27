import { LOCAL_HOST_ID, type ProjectDTO, type RoomCreateBody, type ServerDTO, type SessionDTO } from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { Db, EventBus, Fleet, HubEvents as Events, RoomsService } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createHostLookups, type KnownHost } from '../../src/fleet/host-lookups.js';
import { createRoomsService, type RoomsDeps } from '../../src/rooms/index.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';

export const NOW = '2026-11-21T08:00:00.000Z';

/** ash, birch and cedar over SSH (projects under /srv/projects), plus this computer. */
export const HOSTS: readonly KnownHost[] = [
  { name: 'ash', projectsRoot: '/srv/projects' },
  { name: 'birch', projectsRoot: '/srv/projects' },
  { name: 'cedar', projectsRoot: '/srv/projects' },
  { name: LOCAL_HOST_ID, kind: 'local', projectsRoot: '/home/owner/projects' },
];

export type RoomsFleet = Pick<Fleet, 'hasServer' | 'hasLocal' | 'hostInfo' | 'servers'>;

export function fleetOf(hosts: readonly KnownHost[] = HOSTS): RoomsFleet {
  const lookups = createHostLookups(() => hosts);
  return { ...lookups, servers: () => hosts.map((host) => ({ name: host.name }) as ServerDTO) };
}

export interface Rig {
  readonly rooms: RoomsService;
  readonly db: Db;
  readonly bus: EventBus;
  readonly clock: ReturnType<typeof createFakeClock>;
  /** Every event the rooms service (and its cascade) emitted, in order. */
  readonly events: Array<{ name: keyof Events; payload: unknown }>;
}

const WATCHED: ReadonlyArray<keyof Events> =['rooms.changed', 'links.changed', 'jira.changed', 'accounts.changed'];

export function rig(over: Partial<RoomsDeps> = {}): Rig {
  const db = over.db ?? openMemoryDb();
  const bus = over.bus ?? createBus();
  const clock = createFakeClock(NOW);
  const events: Rig['events'] = [];
  for (const name of WATCHED) bus.on(name, (payload) => events.push({ name, payload }));
  const rooms = createRoomsService({ db, bus, clock, log: silentLogger(), fleet: fleetOf(), ...over });
  return { rooms, db, bus, clock, events };
}

export const serverRoom = (host: string, name: string, over: Partial<RoomCreateBody> = {}): RoomCreateBody => ({ name, kind: 'server', host, ...over });

export const projectRoom = (name: string, glob: string, over: Partial<RoomCreateBody> = {}): RoomCreateBody => ({
  name, kind: 'project', host: null, match: [{ by: 'name', glob }], ...over,
});

export function session(over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: 'birch:cc-orchard:0.0', host: 'birch', target: 'cc-orchard:0.0', claudeSessionId: null, cwd: '/srv/projects/orchard',
    project: 'orchard', displayName: 'orchard', state: 'idle', origin: 'owner', registered: true, lastEventAt: NOW, turnStartedAt: null,
    pendingQid: null, unexpectedEnd: false, ...over,
  };
}

export function project(over: Partial<ProjectDTO> = {}): ProjectDTO {
  return {
    server: 'birch', path: '/srv/projects/orchard', name: 'orchard', remote: null, branch: 'main', commits: [], stack: [], updatedAt: NOW,
    ...over,
  };
}

export function insertLink(db: Db, room: string, label: string, position: number): void {
  db.prepare('INSERT INTO links (server, label, url, position, created_at) VALUES (?, ?, ?, ?, ?)').run(room, label, `https://example.com/${label}`, position, NOW);
}

export const linksOf = (db: Db, room: string): string[] =>
  (db.prepare('SELECT label FROM links WHERE server = ? ORDER BY position').all(room) as Array<{ label: string }>).map((row) => row.label);

export function insertJira(db: Db, room: string): void {
  db.prepare(`INSERT INTO jira_sites (server, base_url, email, token_enc, connected_at) VALUES (?, 'https://orchard-demo.atlassian.net',
    'owner@example.com', 'sealed', ?)`).run(room, NOW);
  db.prepare('INSERT INTO jira_seen (server, key, seen_at) VALUES (?, ?, ?)').run(room, 'ORC-1', NOW);
}

export const jiraRooms = (db: Db): string[] =>
  (db.prepare('SELECT server FROM jira_sites ORDER BY server').all() as Array<{ server: string }>).map((row) => row.server);

/** A hosts-table tombstone: the host was removed (the host removal writes it before applying the rooms rule). */
export function tombstone(db: Db, id: string): void {
  db.prepare(`INSERT INTO servers (name, host, user, status, kind, source, state, created_at, updated_at, removed_at)
    VALUES (?, ?, 'dev', 'offline', 'ssh', 'web', 'removed', ?, ?, ?)`).run(id, `${id}.example.com`, NOW, NOW, NOW);
}
