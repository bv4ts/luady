import { vi } from 'vitest';
import { DEFAULT_SETTINGS, type ActionDTO, type QuestionDTO, type SessionDTO } from '@luady/shared';
import type { MemoryService, ToolContext } from '../../src/core/contracts.js';
import { createFakeClock, createFakeCtl, classicHostLookups } from '../../test/helpers/fakes.js';

export const SID = 'cedar:cc-meadow-hr:0.0';

export function makeSession(over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: SID,
    host: 'cedar',
    target: 'cc-meadow-hr:0.0',
    claudeSessionId: 'c0ffee00-0000-4000-8000-000000000001',
    cwd: '/home/dev/projects/meadow-hr',
    project: 'meadow-hr',
    displayName: 'meadow-hr',
    state: 'idle',
    origin: 'owner',
    registered: true,
    lastEventAt: '2026-10-09T11:50:00.000Z',
    turnStartedAt: null,
    pendingQid: null,
    unexpectedEnd: false,
    ...over,
  };
}

export function makeQuestion(over: Partial<QuestionDTO> = {}): QuestionDTO {
  return {
    qid: 'AAAAAAAA',
    kind: 'question',
    host: 'cedar',
    sessionId: SID,
    sessionLabel: 'cedar · meadow-hr',
    questions: [{ question: 'Which database should I use?', options: [{ label: 'Postgres' }, { label: 'MySQL' }] }],
    permission: null,
    state: 'pending',
    createdAt: '2026-10-09T11:58:00.000Z',
    resolvedAt: null,
    resolvedVia: null,
    ...over,
  };
}

export function makeAction(over: Partial<ActionDTO> = {}): ActionDTO {
  return {
    id: 'A7',
    actor: 'manager',
    channel: 'event',
    kind: 'session.stop',
    tier: 1,
    summary: 'stop session cedar · meadow-hr — reason: done',
    status: 'pending_confirmation',
    createdAt: '2026-10-09T12:00:00.000Z',
    decidedAt: null,
    result: null,
    error: null,
    ...over,
  };
}

function recordMemory(msg: Parameters<MemoryService['record']>[0]) {
  return { id: 'm1', thread: msg.thread, role: msg.role, channel: msg.channel, text: msg.text, ts: '2026-10-09T12:00:00.000Z' };
}

/** Every ToolContext member as vi.fn stubs with harmless defaults; tests override with vi.mocked(...). */
export function createFakeToolContext(): ToolContext {
  const ctl = createFakeCtl();
  return {
    fleet: {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      client: vi.fn(() => ctl),
      servers: vi.fn(() => []),
      openShell: vi.fn(async () => {
        throw new Error('openShell is not used by tools');
      }),
      ...classicHostLookups(), tailEvents: vi.fn(() => ({ stop: () => {}, done: Promise.resolve() })),
    },
    sessions: {
      list: vi.fn(() => []),
      get: vi.fn(() => undefined),
      findByRef: vi.fn(() => undefined),
      send: vi.fn(async () => {}),
      interrupt: vi.fn(async () => {}),
      start: vi.fn(async () => makeSession()),
      stop: vi.fn(async () => {}),
      restart: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      transcript: vi.fn(async () => ({ items: [], nextCursor: null })),
      condensed: vi.fn(async () => ''),
    },
    questions: {
      pending: vi.fn(() => []),
      get: vi.fn(() => undefined),
      check: vi.fn(() => makeQuestion()),
      answer: vi.fn(async () => makeQuestion({ state: 'answered' })),
      answerPermission: vi.fn(async () => makeQuestion({ state: 'answered' })),
      release: vi.fn(async () => makeQuestion({ state: 'released' })),
      markNotified: vi.fn(),
      markEscalated: vi.fn(),
    },
    actions: {
      request: vi.fn(async () => makeAction()),
      confirm: vi.fn(async () => makeAction()),
      deny: vi.fn(async () => makeAction()),
      get: vi.fn(() => undefined),
      list: vi.fn(() => []),
      pending: vi.fn(() => []),
      sweepExpired: vi.fn(() => 0),
    },
    projects: { list: vi.fn(() => []), refresh: vi.fn(async () => {}) },
    memory: { record: vi.fn(recordMemory), search: vi.fn(() => []) },
    outbound: {
      isUp: vi.fn(() => true),
      send: vi.fn(async (): Promise<string | null> => 'wamid-1'),
      sendMedia: vi.fn(async (): Promise<string> => 'wamid-media'),
      typing: vi.fn(),
    },
    phone: { enabled: vi.fn(() => false), callForQuestion: vi.fn(async () => {}), callOwner: vi.fn(async () => {}) },
    scheduler: {
      add: vi.fn((when: string, task: string) => ({ id: 'S1', when, task, nextRunAt: null })),
      list: vi.fn(() => []),
      cancel: vi.fn(() => false),
      start: vi.fn(),
      stop: vi.fn(),
    },
    settings: { get: vi.fn(() => structuredClone(DEFAULT_SETTINGS)), update: vi.fn(() => structuredClone(DEFAULT_SETTINGS)) },
    clock: createFakeClock(),
    inboxDir: '/home/luady/brain/inbox',
  };
}
