import { z } from 'zod';
import { CtlCommitSchema, isHostId, type CtlProject, type ProjectDTO, type ServerDTO, type HostId } from '@luady/shared';
import type { Clock, Db, Fleet, Logger, ProjectsService } from '../core/contracts.js';
import { PER_HOST_CONCURRENCY, withTimeout } from '../core/concurrency.js';
import { isoNow } from '../core/time.js';

export interface ProjectsDeps {
  db: Db;
  clock: Clock;
  fleet: Fleet;
  log: Logger;
  /** After each refresh, with every known project (writes PROJECTS.auto.md). */
  onUpdated?: (all: ProjectDTO[]) => void;
}

export const PROJECTS_REFRESH_MS = 6 * 60 * 60_000;
export const PROJECTS_POLL_MS = 60_000;
export const PROJECTS_RETRY_MS = 10 * 60_000;
/** One host's scan may take this long before it counts as failed (and is retried later). */
export const PROJECTS_TIMEOUT_MS = 2 * 60_000;

const GitSchema = z.object({ remote: z.string().nullable(), branch: z.string().nullable(), commits: z.array(CtlCommitSchema) });
const StackSchema = z.array(z.string());
const RowSchema = z.object({
  server: z.string(),
  path: z.string(),
  name: z.string(),
  git_json: z.string(),
  stack_json: z.string(),
  updated_at: z.string(),
});
const SELECT = 'SELECT server, path, name, git_json, stack_json, updated_at FROM projects';

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A row that does not parse (or names no host id) is left out and logged with its key (no silent drops). */
function toProjectDto(raw: unknown, log: Logger): ProjectDTO | null {
  const row = RowSchema.safeParse(raw);
  const drop = (issue: string): null => {
    const key = row.success ? `${row.data.server}:${row.data.path}` : '?';
    log.warn({ table: 'projects', key, issue }, 'projects: a row does not parse and is left out');
    return null;
  };
  if (!row.success) return drop(row.error.issues[0]?.message ?? 'not a projects row');
  const server = row.data.server;
  if (!isHostId(server)) return drop('not a host id');
  const git = GitSchema.safeParse(parseJson(row.data.git_json));
  const stack = StackSchema.safeParse(parseJson(row.data.stack_json));
  if (!git.success || !stack.success) return drop('git or stack JSON does not parse');
  return {
    server,
    path: row.data.path,
    name: row.data.name,
    remote: git.data.remote,
    branch: git.data.branch,
    commits: git.data.commits,
    stack: stack.data,
    updatedAt: row.data.updated_at,
  };
}

/** `luady-ctl projects` per server into the `projects` table: on reconnect, every 6 h, retry 10 min after a failure. */
export function createProjectsService(deps: ProjectsDeps): ProjectsService & { start(): void; stop(): void } {
  const selectAll = deps.db.prepare(`${SELECT} ORDER BY server, name, path`);
  const selectServer = deps.db.prepare(`${SELECT} WHERE server = ? ORDER BY name, path`);
  const remove = deps.db.prepare('DELETE FROM projects WHERE server = ?');
  const insert = deps.db.prepare(
    'INSERT OR REPLACE INTO projects (server, path, name, git_json, stack_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const replaceAll = deps.db.transaction((server: HostId, projects: readonly CtlProject[], nowIso: string) => {
    remove.run(server);
    for (const project of projects) {
      const git = JSON.stringify({ remote: project.remote, branch: project.branch, commits: project.commits });
      insert.run(server, project.path, project.name, git, JSON.stringify(project.stack), nowIso);
    }
  });
  const lastStatus = new Map<HostId, ServerDTO['status']>();
  const nextDue = new Map<HostId, number>();
  const inflight = new Set<HostId>();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function refresh(server: HostId): Promise<void> {
    const result = await withTimeout(deps.fleet.client(server).projects(), PROJECTS_TIMEOUT_MS, `the project scan of ${server}`);
    replaceAll(server, result.projects, isoNow(deps.clock));
    nextDue.set(server, deps.clock.now().getTime() + PROJECTS_REFRESH_MS);
    deps.onUpdated?.(listAll());
  }

  function refreshInBackground(server: HostId): void {
    inflight.add(server);
    void refresh(server)
      .catch((err: unknown) => {
        nextDue.set(server, deps.clock.now().getTime() + PROJECTS_RETRY_MS);
        deps.log.warn({ server, err: err instanceof Error ? err.message : String(err) }, 'project registry refresh failed');
      })
      .finally(() => {
        inflight.delete(server);
      });
  }

  /**
   * Every host of the fleet (SSH servers and this computer), at most PER_HOST_CONCURRENCY scans at once: a host that
   * is due while the lanes are full is forgotten as scanned, so the next tick takes it.
   */
  function tick(): void {
    const now = deps.clock.now().getTime();
    for (const server of deps.fleet.servers()) {
      const previous = lastStatus.get(server.name);
      lastStatus.set(server.name, server.status);
      if (server.status !== 'online' || inflight.has(server.name)) continue;
      const due = nextDue.get(server.name);
      if (previous !== 'online' || due === undefined || now >= due) {
        if (inflight.size >= PER_HOST_CONCURRENCY) nextDue.delete(server.name);
        else refreshInBackground(server.name);
      }
    }
  }

  function listAll(): ProjectDTO[] {
    return selectAll.all().flatMap((raw) => toProjectDto(raw, deps.log) ?? []);
  }

  return {
    list: (server) => (server === undefined ? listAll() : selectServer.all(server).flatMap((raw) => toProjectDto(raw, deps.log) ?? [])),
    refresh,
    start() {
      if (timer !== null) return;
      tick();
      timer = setInterval(tick, PROJECTS_POLL_MS);
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
