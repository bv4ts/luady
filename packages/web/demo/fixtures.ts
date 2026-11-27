import type { HostId, LuadyStatusDTO, RoomDTO, ServerDTO, SessionDTO } from '@luady/shared';

/** A demo fleet: birch is busy (14 sessions), cedar and ash are quieter (4 and 5), and two sessions sit in Luady's sandbox. */

export const DEMO_HOSTS: readonly HostId[] = ['cedar', 'birch', 'ash', 'local'];

const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();
const MINUTE = 60_000;

export const demoServer = (name: HostId, over: Partial<ServerDTO> = {}): ServerDTO => ({
  name, host: `${name}.internal`, status: 'online', lastSeenAt: iso(5_000), claudeVersion: '2.1.323', kitVersion: '1.4.0',
  sysinfo: { load1: 1.2, load5: 1.1, mem_total_kb: 8_000_000, mem_avail_kb: 3_200_000, disk_free_kb: 40 * 1024 * 1024, uptime_s: 86_400 },
  kind: 'ssh', projectsRoot: null, homeDir: null, terminal: true,
  ...over,
});

export const DEMO_SERVERS: readonly ServerDTO[] = [
  demoServer('cedar', { sysinfo: { load1: 0.4, load5: 0.5, mem_total_kb: 8_000_000, mem_avail_kb: 5_000_000, disk_free_kb: 60 * 1024 * 1024, uptime_s: 90_000 } }),
  demoServer('birch', { sysinfo: { load1: 3.6, load5: 3.1, mem_total_kb: 8_000_000, mem_avail_kb: 900_000, disk_free_kb: 30 * 1024 * 1024, uptime_s: 400_000 } }),
  demoServer('ash', { sysinfo: { load1: 1.9, load5: 1.7, mem_total_kb: 8_000_000, mem_avail_kb: 2_500_000, disk_free_kb: 6 * 1024 * 1024, uptime_s: 50_000 } }),
  demoServer('local'),
];

const EPOCH = '1970-01-01T00:00:00.000Z';
const demoRoom = (id: string, position: number, name: string, short: string, colour: string, accent: string, species: RoomDTO['species'], globs: readonly string[]): RoomDTO => ({
  id, name, short, kind: 'server', host: id, match: globs.map((glob) => ({ by: 'name' as const, glob })), colour, accent, species, position,
  size: 'm', hostState: 'ok', createdAt: EPOCH, updatedAt: EPOCH,
});

/** The classic four as rooms, each with its colours and home projects. */
export const DEMO_ROOMS: readonly RoomDTO[] = [
  demoRoom('birch', 0, 'Orchard', 'Orchard', '#d6336c', '#74b816', 'bun', ['orchard*', 'dev_orchard*']),
  demoRoom('ash', 1, 'Harbor', 'Harbor', '#f76707', '#37b24d', 'bot', ['harbor*']),
  demoRoom('cedar', 2, 'Meadow', 'Meadow', '#12b886', '#c3fae8', 'shield', ['meadow*']),
  demoRoom('local', 3, 'Private Projects', 'Private', '#7c5cff', '#ffd84d', 'ghost', []),
];

interface Seed { readonly name: string; readonly project: string | null; readonly state: SessionDTO['state']; readonly quietMin?: number }

const SEEDS: Readonly<Record<HostId, readonly Seed[]>> = {
  cedar: [
    { name: 'meadow-vat', project: 'meadow-vat', state: 'working' },
    { name: 'meadow-api', project: 'meadow-api', state: 'waiting_permission' },
    { name: 'fitness-demo', project: 'fitness-demo', state: 'idle', quietMin: 12 },
    { name: 'meadow-admin', project: 'meadow-admin', state: 'idle' },
  ],
  birch: [
    { name: 'app-backend', project: 'orchard-backend', state: 'working' },
    { name: 'jira-1105', project: 'orchard-backend', state: 'waiting_question' },
    { name: 'client-preferences', project: 'orchard-web', state: 'working' },
    { name: 'orchard-web', project: 'orchard-web', state: 'working' },
    { name: 'orchard-api', project: 'orchard-api', state: 'idle', quietMin: 7 },
    { name: 'store-desk', project: 'orchard-store', state: 'working' },
    { name: 'figma-sync', project: 'orchard-design', state: 'idle' },
    { name: 'dev-orchard-ios', project: 'dev_orchard-ios', state: 'working' },
    { name: 'orchard-android', project: 'orchard-android', state: 'error' },
    { name: 'menu-import', project: 'orchard-backend', state: 'working' },
    { name: 'payments', project: 'orchard-payments', state: 'working' },
    { name: 'jira-1121', project: 'orchard-web', state: 'idle' },
    { name: 'search-index', project: 'orchard-search', state: 'working' },
    { name: 'push-service', project: 'orchard-push', state: 'working' },
  ],
  ash: [
    { name: 'harbor-web', project: 'harbor-web', state: 'working' },
    { name: 'harbor-api', project: 'harbor-api', state: 'working' },
    { name: 'harbor-admin', project: 'harbor-admin', state: 'waiting_question' },
    { name: 'harbor-mobile', project: 'harbor-mobile', state: 'idle' },
    { name: 'harbor-infra', project: 'harbor-infra', state: 'working' },
  ],
  local: [
    { name: 'research', project: 'research', state: 'working' },
    { name: 'picture-desk', project: 'pictures', state: 'idle', quietMin: 30 },
  ],
};

export const demoSession = (host: HostId, seed: Seed): SessionDTO => ({
  id: `${host}:${seed.name}:0.0`, host, target: `${seed.name}:0.0`, claudeSessionId: null, cwd: null, project: seed.project,
  displayName: seed.name, state: seed.state, origin: 'owner', registered: true, lastEventAt: iso((seed.quietMin ?? 0) * MINUTE),
  turnStartedAt: null, pendingQid: null, unexpectedEnd: seed.state === 'error',
});

export const demoSessions = (): SessionDTO[] => DEMO_HOSTS.flatMap((host) => (SEEDS[host] ?? []).map((seed) => demoSession(host, seed)));

export const demoLuady = (state: LuadyStatusDTO['state']): LuadyStatusDTO => ({ state, since: iso(MINUTE), claudeSessionId: null, queued: state === 'busy' ? 2 : 0 });

/** The next state when the owner presses "Cycle state". */
export const STATE_CYCLE: readonly SessionDTO['state'][] = ['working', 'waiting_question', 'waiting_permission', 'error', 'idle'];

export function nextState(state: SessionDTO['state']): SessionDTO['state'] {
  const i = STATE_CYCLE.indexOf(state);
  return STATE_CYCLE[(i + 1) % STATE_CYCLE.length] ?? 'working';
}

const EXTRA_NAMES = ['hotfix', 'review', 'migration', 'tests', 'docs', 'refactor', 'spike', 'release'];

/** A fresh session for a room, named like the others. */
export function freshSession(host: HostId, taken: ReadonlySet<string>): SessionDTO {
  const base = EXTRA_NAMES.find((n) => !taken.has(`${host}:${n}:0.0`)) ?? `task-${taken.size + 1}`;
  const name = taken.has(`${host}:${base}:0.0`) ? `${base}-${Date.now() % 10_000}` : base;
  return { ...demoSession(host, { name, project: host === 'cedar' ? 'meadow-vat' : host === 'ash' ? 'harbor-web' : host === 'birch' ? 'orchard-web' : 'sandbox', state: 'working' }), lastEventAt: new Date().toISOString() };
}
