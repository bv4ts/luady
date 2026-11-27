import { classicHostLookups } from '../helpers/fakes.js';
import { vi } from 'vitest';
import type { CtlExec, SessionDTO } from '@luady/shared';
import type { PauseService } from '../../src/activity/pause.js';
import type { CtlClient, Fleet, PinService, SessionService } from '../../src/core/contracts.js';
import { PinInvalidError } from '../../src/core/errors.js';

export const SID = 'cedar:cc-meadow-hr:0.0';
export const GOOD_PIN = '135790';
export const EXEC_OK: CtlExec = { exit: 0, stdout: 'ok\n', stderr: '', truncated: false, timed_out: false };

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

export function createFleetStub(ctl: CtlClient): Fleet {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    client: vi.fn(() => ctl),
    servers: vi.fn(() => []),
    openShell: vi.fn(async () => {
      throw new Error('openShell is not used by actions');
    }),
    ...classicHostLookups(), tailEvents: vi.fn(() => ({ stop: () => {}, done: Promise.resolve() })),
  };
}

export function createSessionsStub(sessions: readonly SessionDTO[] = [makeSession()]): SessionService {
  return {
    list: vi.fn(() => [...sessions]),
    get: vi.fn((id: string) => sessions.find((session) => session.id === id)),
    findByRef: vi.fn(() => undefined),
    send: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    start: vi.fn(async () => makeSession({ id: 'cedar:cc-mission:0.0', target: 'cc-mission:0.0', displayName: 'mission', origin: 'manager' })),
    stop: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    transcript: vi.fn(async () => ({ items: [], nextCursor: null })),
    condensed: vi.fn(async () => ''),
  };
}

export function createPinStub(): PinService {
  return {
    isSet: vi.fn(() => true),
    set: vi.fn(async () => {}),
    verify: vi.fn(async (pin: string) => {
      if (pin !== GOOD_PIN) throw new PinInvalidError(2);
    }),
  };
}

export function createPausesStub(): Pick<PauseService, 'pause' | 'resume'> {
  return {
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => ({ sent: true })),
  };
}

/** The owner's channel as the executor sees it: `channel.unlink` only. */
export function createChannelStub(): { unlink: ReturnType<typeof vi.fn> } {
  return { unlink: vi.fn(async () => {}) };
}
