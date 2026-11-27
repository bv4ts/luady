import type { HostId, LuadyStatusDTO, QuestionDTO, ServerDTO, SessionDTO } from '@luady/shared';

export const NOW = Date.parse('2026-11-14T12:00:00.000Z');
export const MINUTE = 60_000;

/** An ISO time `msAgo` before NOW. */
export const ago = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

type Sysinfo = NonNullable<ServerDTO['sysinfo']>;

export const sysinfo = (over: Partial<Sysinfo> = {}): Sysinfo => ({
  load1: 1, load5: 1, mem_total_kb: 8_000_000, mem_avail_kb: 4_000_000, disk_free_kb: 50 * 1024 * 1024, uptime_s: 3600, ...over,
});

export const server = (name: HostId, over: Partial<ServerDTO> = {}): ServerDTO => ({
  name, host: `${name}.example`, status: 'online', lastSeenAt: ago(0), claudeVersion: '2.1.0', kitVersion: '1.0.0', sysinfo: sysinfo(),
  kind: 'ssh', projectsRoot: null, homeDir: null, terminal: true, ...over,
});

export const ALL_SERVERS: readonly ServerDTO[] = [server('cedar'), server('birch'), server('ash'), server('local')];

/** A registered owner session working right now; the host is the part of the id before the first ':'. */
export const session = (id: string, over: Partial<SessionDTO> = {}): SessionDTO => ({
  id, host: (id.split(':')[0] ?? 'birch') as HostId, target: 'main:0.1', claudeSessionId: null, cwd: null, project: null,
  displayName: `name of ${id}`, state: 'working', origin: 'owner', registered: true, lastEventAt: ago(0), turnStartedAt: null,
  pendingQid: null, unexpectedEnd: false, ...over,
});

/**
 * The row the hub publishes the moment it starts a session (hub sessions/commands.ts `start`): createSessionRow plus
 * state 'starting'. Not registered yet: the kit registers it at SessionStart.
 */
export const startingSession = (host: HostId, name: string): SessionDTO => ({
  id: `${host}:luady-${name}:0.0`, host, target: `luady-${name}:0.0`, claudeSessionId: null,
  cwd: '/home/dev/projects/orchard', project: 'orchard', displayName: name, state: 'starting', origin: 'owner',
  registered: false, lastEventAt: null, turnStartedAt: null, pendingQid: null, unexpectedEnd: false,
});

export const question = (qid: string, sessionId: string, createdAt: string, over: Partial<QuestionDTO> = {}): QuestionDTO => ({
  qid, kind: 'question', host: (sessionId.split(':')[0] ?? 'birch') as HostId, sessionId, sessionLabel: sessionId, questions: [],
  permission: null, state: 'pending', createdAt, resolvedAt: null, resolvedVia: null, ...over,
});

export const luadyStatus = (over: Partial<LuadyStatusDTO> = {}): LuadyStatusDTO => ({
  state: 'running', since: ago(MINUTE), claudeSessionId: null, queued: 0, ...over,
});
