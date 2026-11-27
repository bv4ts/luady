import { mkdir, rename, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import type { ProjectDTO, ServerDTO, HostId } from '@luady/shared';
import { PER_HOST_CONCURRENCY, forEachLimit } from '../core/concurrency.js';
import type { Fleet, Logger, ProjectsService, SessionService } from '../core/contracts.js';

/** A large repo (19 k nodes) took 2¼ min on a 4-vCPU server; 15 min is the ceiling per project. */
export const GRAPHIFY_TIMEOUT_SEC = 900;
/** Skip a server that is already busy. */
export const GRAPHIFY_MAX_LOAD1 = 3;

export interface GraphifyDeps {
  fleet: Fleet;
  projects: ProjectsService;
  sessions: SessionService;
  brainDir: string;
  log: Logger;
}

export interface GraphifySummary { built: number; skipped: number; failed: number }

/** The kit's own default projects folder, `~/projects` of any user: a path is read against it when its host's is unknown. */
const HOME_PROJECTS = /^\/(?:root|home\/[^/]+)\/projects\//;

/**
 * A folder name that is safe and stable for brain/projects/<server>/<name>: the project's path inside `root`, its host's
 * projects folder (when none is given, inside the user's own `~/projects`, the kit's default).
 */
export function reportDirName(project: ProjectDTO, root?: string | null): string {
  const prefix = root === undefined || root === null ? (HOME_PROJECTS.exec(project.path)?.[0] ?? null) : `${root.replace(/\/+$/, '')}/`;
  const inside = prefix !== null && project.path.startsWith(prefix) ? project.path.slice(prefix.length) : project.path;
  const tail = inside.replace(/[^A-Za-z0-9._-]+/g, '_');
  return tail.replace(/^[._-]+/, '') || 'project';
}

function busyWith(project: ProjectDTO, sessions: SessionService): boolean {
  return sessions.list().some((session) =>
    session.host === project.server && session.state === 'working' && session.cwd !== null
    && (session.cwd === project.path || session.cwd.startsWith(`${project.path}/`)));
}

async function saveReport(brainDir: string, project: ProjectDTO, report: string, root: string | null): Promise<void> {
  const dir = posix.join(brainDir, 'projects', project.server, reportDirName(project, root));
  await mkdir(dir, { recursive: true });
  const target = posix.join(dir, 'GRAPH_REPORT.md');
  await writeFile(`${target}.tmp`, report, { mode: 0o640 });
  await rename(`${target}.tmp`, target);
}

async function runServer(deps: GraphifyDeps, server: ServerDTO, summary: GraphifySummary): Promise<void> {
  const projects = deps.projects.list(server.name);
  if (server.status !== 'online' || (server.sysinfo?.load1 ?? 0) > GRAPHIFY_MAX_LOAD1) {
    deps.log.info({ server: server.name, status: server.status, load1: server.sysinfo?.load1 }, 'graphify: server skipped');
    summary.skipped += projects.length;
    return;
  }
  const root = deps.fleet.hostInfo(server.name)?.projectsRoot ?? null;
  for (const project of projects) {
    if (busyWith(project, deps.sessions)) {
      summary.skipped += 1;
      continue;
    }
    try {
      const result = await deps.fleet.client(server.name).graphifyRun(project.path, GRAPHIFY_TIMEOUT_SEC);
      if (result.report.trim() !== '') await saveReport(deps.brainDir, project, result.report, root);
      summary.built += 1;
      deps.log.info({ server: server.name, project: project.path, seconds: result.seconds }, 'graphify: code map updated');
    } catch (err) {
      summary.failed += 1;
      deps.log.warn({ server: server.name, project: project.path, err: err instanceof Error ? err.message : String(err) }, 'graphify: failed');
    }
  }
}

/** Nightly code maps: projects one at a time per server, PER_HOST_CONCURRENCY servers at once. 0 tokens. */
export async function runGraphify(deps: GraphifyDeps, only?: HostId): Promise<GraphifySummary> {
  const summary: GraphifySummary = { built: 0, skipped: 0, failed: 0 };
  const servers = deps.fleet.servers().filter((server) => only === undefined || server.name === only);
  await forEachLimit(servers, PER_HOST_CONCURRENCY, (server) => runServer(deps, server, summary), (server, err) => {
    summary.failed += 1;
    deps.log.warn({ server: server.name, err: err instanceof Error ? err.message : String(err) }, 'graphify: server failed');
  });
  deps.log.info(summary, 'graphify: nightly run finished');
  return summary;
}
