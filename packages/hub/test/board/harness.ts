import { vi } from 'vitest';
import type {
  BoardItemDTO, JiraIssueDetailDTO, LuadyStatusDTO, MissionDTO, NoteDTO, ProjectDTO, SessionDTO,
} from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import type { HubEvents } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createBoardService } from '../../src/board/index.js';
import { createTodoService } from '../../src/todos/service.js';
import { createFakeClock, createFakeOutbound, silentLogger } from '../helpers/fakes.js';

export const T0 = '2026-11-15T09:00:00.000Z';

export function makeSession(over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: 'birch:cc-checkout:0.0', host: 'birch', target: 'cc-checkout:0.0', claudeSessionId: null, cwd: '/home/dev/projects/orchard',
    project: 'orchard', displayName: 'checkout', state: 'working', origin: 'manager', registered: true, lastEventAt: null,
    turnStartedAt: null, pendingQid: null, unexpectedEnd: false, ...over,
  };
}

export function makeMission(over: Partial<MissionDTO> = {}): MissionDTO {
  return {
    sessionId: 'birch:cc-checkout:0.0', label: 'birch · checkout', title: '', phase: 'working', turns: 0, note: null, lastText: null,
    openedAt: T0, idleSince: null, ...over,
  };
}

export function project(name: string, server: ProjectDTO['server']): ProjectDTO {
  return { server, path: `/home/dev/projects/${name}`, name, remote: null, branch: 'main', commits: [], stack: [], updatedAt: T0 };
}

export function issue(over: Partial<JiraIssueDetailDTO> = {}): JiraIssueDetailDTO {
  return {
    key: 'ORC-123', summary: 'Checkout total ignores the discount', type: 'Bug', status: { name: 'In Progress', category: 'doing' },
    priority: 'High', labels: [], updatedAt: T0, sprint: null, parent: null, flagged: false, hasNews: false,
    url: 'https://orchard-demo.atlassian.net/browse/ORC-123', descriptionMd: 'The total is wrong when a code is used.', reporter: null,
    assignee: null, createdAt: T0, dueDate: null, comments: [], transitions: [], subtasks: [], ...over,
  };
}

export function note(over: Partial<NoteDTO> = {}): NoteDTO {
  return {
    id: 'n:4', kind: 'note', title: 'Stand-up', at: T0, project: 'orchard', people: null, gist: null,
    summary: 'Login done. Checkout next.', actionItems: null, ownerNotes: null, link: null, hasTranscript: false, editable: true, ...over,
  };
}

/** A real board on an in-memory database, with the real to-do service and fakes around it. */
export function boardHarness() {
  const db = openMemoryDb();
  const bus = createBus();
  const clock = createFakeClock(T0);
  const outbound = createFakeOutbound();
  const reminders = createFakeOutbound();
  const todos = createTodoService({ db, clock, log: silentLogger(), outbound });
  const sessions = new Map<string, SessionDTO>([[makeSession().id, makeSession()]]);
  const missions = new Map<string, MissionDTO>();
  const managed = new Set<string>([makeSession().id]);
  const status: { value: LuadyStatusDTO } = { value: { state: 'running', since: T0, claudeSessionId: null, queued: 0 } };
  const signedOut = { value: false };
  const projects: ProjectDTO[] = [project('orchard', 'birch'), project('meadow-hr', 'cedar'), project('shared-lib', 'cedar'), project('shared-lib', 'ash')];
  const luady = {
    postEvent: vi.fn(async (_text: string, _kind: 'Event' | 'Scheduled') => undefined),
    postOwnerRequest: vi.fn(async (_text: string) => undefined),
    status: () => status.value,
    signedOut: () => signedOut.value,
  };
  const jira = { issue: vi.fn(async (_server: string, key: string) => issue({ key })) };
  const notes = { get: vi.fn(async (id: string) => (id === 'n:4' ? note() : null)) };
  const board = createBoardService({
    db, bus, clock, log: silentLogger(), todos, jira, notes, luady, reminders, projects: { list: () => projects },
    sessions: {
      get: (id) => sessions.get(id),
      findByRef: (ref) => sessions.get(ref) ?? [...sessions.values()].find((s) => s.displayName === ref),
    },
    missions: { isManaged: (id) => managed.has(id), views: () => [...missions.values()], view: (id) => missions.get(id) ?? null },
  });
  const updated: BoardItemDTO[][] = [];
  const removed: number[][] = [];
  bus.on('board.updated', ({ items }) => updated.push(items));
  bus.on('board.removed', ({ ids }) => removed.push(ids));
  board.start();
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const emit = async <K extends keyof HubEvents>(name: K, payload: HubEvents[K]): Promise<void> => {
    bus.emit(name, payload);
    await settle();
  };
  const row = (id: number) => db.prepare('SELECT state, done, done_at, session_id, today, auto FROM todos WHERE id = ?').get(id) as {
    state: string; done: number; done_at: string | null; session_id: string | null; today: number; auto: number;
  };
  return {
    db, bus, clock, outbound, reminders, todos, board, sessions, missions, managed, status, signedOut, projects, luady, jira, notes, updated, removed,
    settle, emit, row,
  };
}
