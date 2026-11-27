import { z } from 'zod';
import { HostIdSchema, SESSION_ORIGINS, SessionStateSchema, type Channel, type HostId, type SessionDTO } from '@luady/shared';
import type { Db, Logger } from '../core/contracts.js';
import type { SessionRow } from './registry.js';

export const CLOCK_SKEW_MS = 5_000;
export const INJECTION_HASH_WINDOW_MS = 60_000;
export const INJECTION_RECENT_WINDOW_MS = 15_000;

/** Any host id (open ids; the self host's id passes the same grammar): no row is dropped for its host. */
const DbRowSchema = z.object({
  id: z.string(),
  host: HostIdSchema,
  tmux_target: z.string(),
  claude_session_id: z.string().nullable(),
  transcript_path: z.string().nullable(),
  cwd: z.string().nullable(),
  project: z.string().nullable(),
  display_name: z.string(),
  state: SessionStateSchema,
  origin: z.enum(SESSION_ORIGINS),
  registered: z.number(),
  created_at: z.string(),
  last_event_at: z.string().nullable(),
  turn_started_at: z.string().nullable(),
  turn_remote: z.number(),
  pending_qid: z.string().nullable(),
  unexpected_end: z.number(),
});

const COLUMNS =
  'id, host, tmux_target, claude_session_id, transcript_path, cwd, project, display_name, state, origin, registered, created_at, last_event_at, turn_started_at, turn_remote, pending_qid, unexpected_end';

const UPSERT = `INSERT INTO sessions (${COLUMNS}) VALUES (@id, @host, @tmuxTarget, @claudeSessionId, @transcriptPath, @cwd, @project,
  @displayName, @state, @origin, @registered, @createdAt, @lastEventAt, @turnStartedAt, @turnRemote, @pendingQid, @unexpectedEnd)
ON CONFLICT(id) DO UPDATE SET host = excluded.host, tmux_target = excluded.tmux_target,
  claude_session_id = excluded.claude_session_id, transcript_path = excluded.transcript_path, cwd = excluded.cwd,
  project = excluded.project, display_name = excluded.display_name, state = excluded.state, origin = excluded.origin,
  registered = excluded.registered, created_at = excluded.created_at, last_event_at = excluded.last_event_at,
  turn_started_at = excluded.turn_started_at, turn_remote = excluded.turn_remote, pending_qid = excluded.pending_qid,
  unexpected_end = excluded.unexpected_end`;

const MATCH_INJECTION = `SELECT 1 AS hit FROM injections WHERE session_id = @sessionId AND created_at <= @upper
  AND ((text_sha256 = @hash AND created_at >= @hashLower) OR created_at >= @recentLower) LIMIT 1`;

export interface SessionsRepo {
  get(id: string): SessionRow | undefined;
  list(): SessionRow[];
  listByHost(host: HostId): SessionRow[];
  save(row: SessionRow): void;
  remove(id: string): void;
  recordInjection(sessionId: string, textSha256: string, channel: Channel, createdAt: string): void;
  matchesInjection(sessionId: string, promptSha256: string, promptTs: string): boolean;
}

/** A row that does not parse is left out and logged with its table and key (no silent drops). */
function fromDb(raw: unknown, log?: Logger): SessionRow | null {
  if (raw === undefined) return null;
  const parsed = DbRowSchema.safeParse(raw);
  if (!parsed.success) {
    const key = typeof raw === 'object' && raw !== null && 'id' in raw ? String(raw.id) : '?';
    log?.warn({ table: 'sessions', key, issue: parsed.error.issues[0]?.message }, 'sessions: a row does not parse and is left out');
    return null;
  }
  const r = parsed.data;
  return {
    id: r.id,
    host: r.host,
    tmuxTarget: r.tmux_target,
    claudeSessionId: r.claude_session_id,
    transcriptPath: r.transcript_path,
    cwd: r.cwd,
    project: r.project,
    displayName: r.display_name,
    state: r.state,
    origin: r.origin,
    registered: r.registered === 1,
    createdAt: r.created_at,
    lastEventAt: r.last_event_at,
    turnStartedAt: r.turn_started_at,
    turnRemote: r.turn_remote === 1,
    pendingQid: r.pending_qid,
    unexpectedEnd: r.unexpected_end === 1,
  };
}

function toParams(row: SessionRow): Record<string, string | number | null> {
  return {
    ...row,
    registered: row.registered ? 1 : 0,
    turnRemote: row.turnRemote ? 1 : 0,
    unexpectedEnd: row.unexpectedEnd ? 1 : 0,
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function toSessionDto(row: SessionRow): SessionDTO {
  return {
    id: row.id,
    host: row.host,
    target: row.tmuxTarget,
    claudeSessionId: row.claudeSessionId,
    cwd: row.cwd,
    project: row.project,
    displayName: row.displayName,
    state: row.state,
    origin: row.origin,
    registered: row.registered,
    lastEventAt: row.lastEventAt,
    turnStartedAt: row.turnStartedAt,
    pendingQid: row.pendingQid,
    unexpectedEnd: row.unexpectedEnd,
  };
}

export function createSessionsRepo(db: Db, log?: Logger): SessionsRepo {
  const byId = db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`);
  const all = db.prepare(`SELECT ${COLUMNS} FROM sessions ORDER BY host, display_name, id`);
  const byHost = db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE host = ? ORDER BY display_name, id`);
  const upsert = db.prepare(UPSERT);
  const del = db.prepare('DELETE FROM sessions WHERE id = ?');
  const inject = db.prepare('INSERT INTO injections (session_id, text_sha256, channel, created_at) VALUES (?, ?, ?, ?)');
  const match = db.prepare(MATCH_INJECTION);
  const rows = (raws: unknown[]): SessionRow[] => raws.flatMap((raw) => fromDb(raw, log) ?? []);
  return {
    get: (id) => fromDb(byId.get(id), log) ?? undefined,
    list: () => rows(all.all()),
    listByHost: (host) => rows(byHost.all(host)),
    save: (row) => {
      upsert.run(toParams(row));
    },
    remove: (id) => {
      del.run(id);
    },
    recordInjection: (sessionId, textSha256, channel, createdAt) => {
      inject.run(sessionId, textSha256, channel, createdAt);
    },
    matchesInjection: (sessionId, promptSha256, promptTs) => {
      const at = Date.parse(promptTs);
      if (Number.isNaN(at)) return false;
      const window = {
        sessionId,
        hash: promptSha256,
        upper: iso(at + CLOCK_SKEW_MS),
        hashLower: iso(at - INJECTION_HASH_WINDOW_MS),
        recentLower: iso(at - INJECTION_RECENT_WINDOW_MS),
      };
      return match.get(window) !== undefined;
    },
  };
}
