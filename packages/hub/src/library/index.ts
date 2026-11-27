import {
  CtlSkillsSchema, KIT_V21, versionAtLeast, type LibraryDTO, type LibraryOfficeDTO, type ProjectDTO, type RoomDTO, type HostId,
  type SessionDTO, type SkillDTO,
} from '@luady/shared';
import { PER_HOST_CONCURRENCY, forEachLimit } from '../core/concurrency.js';
import type {
  BoardService, Clock, EventBus, Fleet, KbService, LibraryService, Logger, ProjectsService, SessionService,
} from '../core/contracts.js';
import { isoNow } from '../core/time.js';
import { officeOrder } from './offices.js';
import { readLuadySkills } from './skills.js';

/** Everything the library needs (wired in app.ts). */
export interface LibraryDeps {
  bus: EventBus;
  clock: Clock;
  log: Logger;
  /** The kit's `skills` verb per server. */
  fleet: Fleet;
  projects: ProjectsService;
  sessions: SessionService;
  /** Open cards per project. */
  board: BoardService;
  /** Pages per project. */
  kb: KbService;
  /** Luady's own skills live in `<brainDir>/skills`. */
  brainDir: string;
  /** The rooms, read at call time: offices are listed in their home rooms' order (rooms/). Absent: by host id. */
  rooms?: () => readonly RoomDTO[];
}

export const SKILLS_REFRESH_MS = 6 * 60 * 60_000;

interface SkillsEntry { readonly skills: SkillDTO[] | null; readonly at: string | null }

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function onProject(session: SessionDTO, project: ProjectDTO): boolean {
  if (session.host !== project.server || session.state === 'ended') return false;
  const cwd = session.cwd ?? '';
  return session.project === project.name || cwd === project.path || cwd.startsWith(`${project.path}/`);
}

export function createLibraryService(deps: LibraryDeps): LibraryService {
  const skills = new Map<HostId, SkillsEntry>();
  /** Per server: its link state and kit version when last seen. */
  const lastSeen = new Map<HostId, string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let off: (() => void) | null = null;

  const changed = (): void => deps.bus.emit('library.changed', { at: isoNow(deps.clock) });

  /** The kit's skill list, or null when the kit is older than 2.1 or the call failed. Offline servers keep what they had. */
  async function readSkills(server: HostId): Promise<boolean> {
    const dto = deps.fleet.servers().find((s) => s.name === server);
    if (dto === undefined || dto.status !== 'online') return false;
    let next: SkillsEntry;
    if (!versionAtLeast(dto.kitVersion, KIT_V21)) {
      next = { skills: null, at: null };
    } else {
      try {
        const listed = CtlSkillsSchema.parse(await deps.fleet.client(server).skills());
        next = { skills: listed.skills.map((s) => ({ ...s })), at: isoNow(deps.clock) };
      } catch (err) {
        deps.log.warn({ server, err: errText(err) }, 'library: skills not listed');
        next = { skills: null, at: null };
      }
    }
    const before = skills.get(server);
    skills.set(server, next);
    return JSON.stringify(before?.skills ?? null) !== JSON.stringify(next.skills) || before === undefined;
  }

  /** Every listed host, at most PER_HOST_CONCURRENCY at once. */
  async function refreshSkills(servers: readonly HostId[]): Promise<void> {
    let moved = false;
    await forEachLimit(servers, PER_HOST_CONCURRENCY, async (server) => {
      moved = (await readSkills(server)) || moved;
    });
    if (moved) changed();
  }

  /** A host with a kit the fleet has (an SSH server or this computer); never the self host. */
  const isOffice = (name: string): boolean => deps.fleet.hasServer(name) || deps.fleet.hasLocal(name);

  /** A server that comes online has its skills read, and so does an online one whose kit changed (2.1 can list them). */
  function onServer(server: { name: string; status: string; kitVersion?: string | null }): void {
    if (!isOffice(server.name)) return;
    const name = server.name;
    const seen = `${server.status}|${server.kitVersion ?? ''}`;
    const previous = lastSeen.get(name);
    lastSeen.set(name, seen);
    if (server.status === 'online' && previous !== seen) {
      refreshSkills([name]).catch((err: unknown) => deps.log.warn({ server: name, err: errText(err) }, 'library: refresh failed'));
    }
  }

  function office(server: HostId, projects: readonly ProjectDTO[], live: readonly SessionDTO[]): LibraryOfficeDTO {
    const pages = deps.kb.list({ scope: 'project', server }).items;
    const open = deps.board.list().filter((card) => card.state !== 'done' && card.server === server);
    const entry = skills.get(server);
    return {
      server,
      projects: projects.map((project) => ({
        ...project,
        sessions: live.filter((s) => onProject(s, project)).length,
        openItems: open.filter((card) => card.project === project.name).length,
        pages: pages.filter((page) => page.project === project.name).length,
      })),
      skills: entry?.skills ?? null,
      skillsAt: entry?.at ?? null,
    };
  }

  return {
    async get(): Promise<LibraryDTO> {
      const live = deps.sessions.list();
      const servers = deps.fleet.servers().map((s) => s.name).sort(officeOrder(deps.rooms?.() ?? []));
      const offices = servers.map((server) => office(server, deps.projects.list(server), live));
      return { offices, managerSkills: await readLuadySkills(deps.brainDir) };
    },
    async refresh(server) {
      const servers = server === undefined ? deps.fleet.servers().map((s) => s.name) : [server];
      await forEachLimit(servers, PER_HOST_CONCURRENCY, (name) => deps.projects.refresh(name), (name, err) => {
        deps.log.warn({ server: name, err: errText(err) }, 'library: project scan failed');
      });
      await refreshSkills(servers);
      changed();
    },
    start() {
      if (timer !== null) return;
      off = deps.bus.on('server.updated', onServer);
      for (const server of deps.fleet.servers()) onServer(server);
      timer = setInterval(() => {
        refreshSkills(deps.fleet.servers().map((s) => s.name)).catch((err: unknown) => deps.log.warn({ err: errText(err) }, 'library: refresh failed'));
      }, SKILLS_REFRESH_MS);
      timer.unref?.();
    },
    stop() {
      off?.();
      off = null;
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
