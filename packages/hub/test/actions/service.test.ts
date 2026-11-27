import { describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST_ID, type ActionDTO, type CtlExec } from '@luady/shared';
import { createActionService } from '../../src/actions/service.js';
import { createBus } from '../../src/core/bus.js';
import type { ActionRequest, CtlClient, Fleet, Logger, PinService, QuestionService, SessionService } from '../../src/core/contracts.js';
import {
  KitTooOldError,
  NotFoundError,
  PinInvalidError,
  PinLockedError,
  PinNotSetError,
  QuestionPendingError,
  RefusedError,
  SessionPausedError,
  ValidationError,
} from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createTicketStore } from '../../src/security/tickets.js';
import { createFakeClock, createFakeCtl, silentLogger } from '../../test/helpers/fakes.js';
import { createCaptureLogger } from '../security/capture-logger.js';
import { EXEC_OK, GOOD_PIN, SID, createFleetStub, createPausesStub, createPinStub, createSessionsStub, createChannelStub } from './stubs.js';

const MINUTE = 60_000;
const TICKET_NOTE = 'terminal ticket issued (single use, valid 60 s)';

interface SetupOptions {
  requirePin?: boolean;
  pauses?: ReturnType<typeof createPausesStub>;
  sessions?: SessionService;
  pin?: PinService;
  exec?: CtlClient['exec'];
  log?: Logger;
  /** Changes the fleet stub (this computer, the hub's own folders). */
  fleet?: (base: Fleet) => Fleet;
  /** Whether the manager's running turn answers the owner; most tests ask from such a turn. `null`: the hub does not say. */
  ownerTurn?: boolean | null;
  questions?: Pick<QuestionService, 'check' | 'answer'>;
}

function setup(options: SetupOptions = {}) {
  const db = openMemoryDb();
  const bus = createBus();
  const clock = createFakeClock();
  const exec = vi.fn(options.exec ?? (async (): Promise<CtlExec> => EXEC_OK));
  const stub = createFleetStub(createFakeCtl({ exec }));
  const fleet = options.fleet?.(stub) ?? stub;
  const sessions = options.sessions ?? createSessionsStub();
  const pin = options.pin ?? createPinStub();
  const channel = createChannelStub();
  const tickets = createTicketStore(clock);
  const pauses = options.pauses ?? createPausesStub();
  const events: ActionDTO[] = [];
  bus.on('action.updated', (dto) => {
    events.push(dto);
  });
  const actions = createActionService({
    db, bus, clock, log: options.log ?? silentLogger(), fleet, sessions, pin, channel, tickets, pauses,
    ...(options.requirePin === undefined ? {} : { requirePin: () => options.requirePin === true }),
    ...(options.ownerTurn === null ? {} : { managerOwnerTurn: () => options.ownerTurn ?? true }),
    ...(options.questions === undefined ? {} : { questions: options.questions }),
  });
  return { db, clock, exec, sessions, pin, channel, tickets, events, actions };
}

function luady(kind: ActionRequest['kind'], params: Record<string, unknown>): ActionRequest {
  return { kind, actor: 'manager', channel: 'event', params };
}

const sendRequest = (): ActionRequest => luady('session.send', { sessionId: SID, text: 'continue' });
const stopRequest = (): ActionRequest => luady('session.stop', { sessionId: SID, reason: 'task finished' });
const execRequest = (command: string): ActionRequest => luady('server.exec', { server: 'birch', command, reason: 'check the server' });

const INVALID_REQUESTS: Array<{ name: string; req: Record<string, unknown> }> = [
  { name: 'an unknown kind', req: { kind: 'server.reboot', actor: 'manager', channel: 'event', params: {} } },
  { name: 'an unknown actor', req: { kind: 'session.send', actor: 'mallory', channel: 'event', params: { sessionId: SID, text: 'x' } } },
  { name: 'a PIN smuggled into params', req: { kind: 'session.stop', actor: 'manager', channel: 'event', params: { sessionId: SID, pin: GOOD_PIN } } },
  { name: 'the brain session', req: { kind: 'session.stop', actor: 'manager', channel: 'event', params: { sessionId: 'hq:manager:0.0' } } },
  { name: 'a cwd outside the projects root', req: { kind: 'session.start', actor: 'manager', channel: 'event', params: { server: 'cedar', cwd: '/home/dev/projects/../.ssh' } } },
];

const PIN_ERRORS = [
  { name: 'PinInvalidError', error: new PinInvalidError(1) },
  { name: 'PinLockedError', error: new PinLockedError('2026-10-09T12:15:00.000Z') },
  { name: 'PinNotSetError', error: new PinNotSetError() },
];

describe('createActionService.request', () => {
  it('runs tier-0 actions immediately and records each step', async () => {
    const t = setup();
    const dto = await t.actions.request(sendRequest());
    expect(dto).toMatchObject({
      id: 'A1',
      actor: 'manager',
      channel: 'event',
      kind: 'session.send',
      tier: 0,
      status: 'done',
      result: 'sent',
      summary: 'send to cedar · meadow-hr (8 characters, 1 line, sha256 e256ee8e7aff)\n| continue',
    });
    expect(t.sessions.send).toHaveBeenCalledWith(SID, 'continue', 'event');
    expect(t.events.map((event) => event.status)).toEqual(['approved', 'done']);
  });

  it('records a failed tier-0 action with the error', async () => {
    const sessions = createSessionsStub();
    vi.mocked(sessions.send).mockRejectedValue(new QuestionPendingError('ABCDEFGH', 'cedar · meadow-hr is waiting for #ABCDEFGH'));
    const t = setup({ sessions });
    await expect(t.actions.request(sendRequest())).resolves.toMatchObject({
      status: 'failed',
      result: null,
      error: 'cedar · meadow-hr is waiting for #ABCDEFGH',
    });
  });

  it('records a refused pause or paused send as failed and rethrows the coded error for the caller', async () => {
    const sessions = createSessionsStub();
    vi.mocked(sessions.send).mockRejectedValue(new SessionPausedError('cedar · meadow-hr is paused. Resume it first.'));
    const pauses = createPausesStub();
    const tooOld = "cedar's kit is older than 2.0.0 and cannot pause. Update the kit on cedar first.";
    vi.mocked(pauses.pause).mockRejectedValue(new KitTooOldError(tooOld));
    const t = setup({ sessions, pauses });
    await expect(t.actions.request(sendRequest())).rejects.toMatchObject({ code: 'session_paused' });
    await expect(t.actions.request(luady('session.pause', { sessionId: SID }))).rejects.toMatchObject({ code: 'kit_too_old' });
    expect(t.actions.list({ limit: 10 }).map((action) => [action.kind, action.status, action.error])).toEqual([
      ['session.pause', 'failed', tooOld],
      ['session.send', 'failed', 'cedar · meadow-hr is paused. Resume it first.'],
    ]);
  });

  it('runs read-only exec commands now and summarizes the output', async () => {
    const t = setup({ exec: async () => ({ exit: 0, stdout: 'Filesystem  Size\n', stderr: '', truncated: false, timed_out: false }) });
    const dto = await t.actions.request(execRequest('df -h'));
    expect(t.exec).toHaveBeenCalledWith('df -h', '/home/dev', 120);
    expect(dto).toMatchObject({ tier: 0, status: 'done', result: 'exit 0\nstdout:\nFilesystem  Size\n' });
  });

  it('holds tier-1 actions until the owner confirms', async () => {
    const t = setup();
    const dto = await t.actions.request(execRequest('docker compose down'));
    expect(dto).toMatchObject({
      id: 'A1',
      tier: 1,
      status: 'pending_confirmation',
      summary: "run on birch: `docker compose down`\nLuady's reason: check the server",
    });
    expect(t.exec).not.toHaveBeenCalled();
    expect(t.actions.pending().map((action) => action.id)).toEqual(['A1']);
    expect(t.events.map((event) => event.status)).toEqual(['pending_confirmation']);
  });

  it('runs tier-1 actions at once when the owner turned the PIN off', async () => {
    const t = setup({ requirePin: false });
    const dto = await t.actions.request(execRequest('docker compose down'));
    expect(t.exec).toHaveBeenCalledWith('docker compose down', '/home/dev', 120);
    expect(dto).toMatchObject({ tier: 1, status: 'done' });
    expect(t.actions.pending()).toEqual([]);
    expect(t.pin.verify).not.toHaveBeenCalled();
  });

  it('verifies a step-up PIN and executes', async () => {
    const t = setup();
    const dto = await t.actions.request({ ...execRequest('docker compose down'), actor: 'owner', channel: 'web', pin: GOOD_PIN });
    expect(t.pin.verify).toHaveBeenCalledWith(GOOD_PIN, 'web');
    expect(dto).toMatchObject({ status: 'done', decidedAt: '2026-10-09T12:00:00.000Z' });
    expect(t.events.map((event) => event.status)).toEqual(['pending_confirmation', 'approved', 'done']);
  });

  it('leaves the action pending when the step-up PIN is wrong', async () => {
    const t = setup();
    await expect(t.actions.request({ ...stopRequest(), actor: 'owner', channel: 'web', pin: '111111' })).rejects.toBeInstanceOf(PinInvalidError);
    expect(t.actions.get('A1')?.status).toBe('pending_confirmation');
    expect(t.sessions.stop).not.toHaveBeenCalled();
  });

  it('numbers actions A1, A2, … across kinds', async () => {
    const t = setup();
    const first = await t.actions.request(sendRequest());
    const second = await t.actions.request(stopRequest());
    const third = await t.actions.request(execRequest('uptime'));
    expect([first.id, second.id, third.id]).toEqual(['A1', 'A2', 'A3']);
  });

  it.for(INVALID_REQUESTS)('rejects $name without creating a row', async ({ req }) => {
    const t = setup();
    await expect(t.actions.request(req as unknown as ActionRequest)).rejects.toBeInstanceOf(ValidationError);
    expect(t.actions.list({ limit: 10 })).toEqual([]);
  });

  it("refuses a file write or a session start in the hub's own folders on this computer, from anyone, without a row", async () => {
    const hubData = '/home/me/.local/share/luady/data';
    const t = setup({
      fleet: (base) => ({
        ...base,
        hasLocal: (id) => id === LOCAL_HOST_ID,
        hubPathRefusal: (host, path) => (host === LOCAL_HOST_ID && path.startsWith(hubData) ? `${path} belongs to the hub itself` : null),
      }),
    });
    const write = { server: LOCAL_HOST_ID, path: `${hubData}/hub.db`, content: 'x' };
    await expect(t.actions.request(luady('server.file_write', write))).rejects.toBeInstanceOf(RefusedError);
    await expect(t.actions.request({ kind: 'server.file_write', actor: 'owner', channel: 'web', params: write, pin: GOOD_PIN }))
      .rejects.toThrow(/belongs to the hub itself/);
    await expect(t.actions.request(luady('session.start', { server: LOCAL_HOST_ID, cwd: hubData }))).rejects.toBeInstanceOf(RefusedError);
    expect(t.actions.list({ limit: 10 })).toEqual([]);
    expect(t.sessions.start).not.toHaveBeenCalled();
    await expect(t.actions.request(luady('server.file_write', { ...write, path: '/home/me/projects/a.md' })))
      .resolves.toMatchObject({ status: 'pending_confirmation' });
  });

  it('a session start or send from the manager waits for the PIN unless its turn answers the owner', async () => {
    for (const ownerTurn of [false, null] as const) {
      const t = setup({ ownerTurn });
      await expect(t.actions.request(sendRequest())).resolves.toMatchObject({ tier: 1, status: 'pending_confirmation' });
      await expect(t.actions.request(luady('session.start', { server: 'cedar', cwd: '/home/dev/projects/x', prompt: 'go' })))
        .resolves.toMatchObject({ tier: 1, status: 'pending_confirmation' });
      expect(t.sessions.send).not.toHaveBeenCalled();
      expect(t.sessions.start).not.toHaveBeenCalled();
      await expect(t.actions.request(luady('session.interrupt', { sessionId: SID }))).resolves.toMatchObject({ tier: 0, status: 'done' });
    }
    const owner = setup({ ownerTurn: false });
    await expect(owner.actions.request({ kind: 'session.send', actor: 'owner', channel: 'web', params: { sessionId: SID, text: 'hi' } }))
      .resolves.toMatchObject({ tier: 0, status: 'done' });
    const answering = setup({ ownerTurn: true });
    await expect(answering.actions.request(sendRequest())).resolves.toMatchObject({ tier: 0, status: 'done' });
  });

  it('a command the manager runs on this computer always waits for the PIN, even a read-only one', async () => {
    const t = setup({ fleet: (base) => ({ ...base, hasLocal: (id) => id === LOCAL_HOST_ID }) });
    await expect(t.actions.request(luady('server.exec', { server: LOCAL_HOST_ID, command: 'df -h', cwd: '/home/me' })))
      .resolves.toMatchObject({ tier: 1, status: 'pending_confirmation' });
    expect(t.exec).not.toHaveBeenCalled();
  });

  it('a command the owner runs on this computer waits for the PIN too, even a read-only one', async () => {
    const t = setup({ fleet: (base) => ({ ...base, hasLocal: (id) => id === LOCAL_HOST_ID }) });
    const owner: ActionRequest = { kind: 'server.exec', actor: 'owner', channel: 'web', params: { server: LOCAL_HOST_ID, command: 'cat secrets.env', cwd: '/home/me' } };
    await expect(t.actions.request(owner)).resolves.toMatchObject({ tier: 1, status: 'pending_confirmation' });
    expect(t.exec).not.toHaveBeenCalled();
  });

  it('rejects an unknown session without creating a row', async () => {
    const t = setup();
    await expect(t.actions.request(luady('session.stop', { sessionId: 'cedar:cc-nope:0.0' }))).rejects.toBeInstanceOf(NotFoundError);
    expect(t.actions.list({ limit: 10 })).toEqual([]);
  });

  it('executes each kind through its dependency', async () => {
    const t = setup();
    await t.actions.request(luady('session.start', { server: 'cedar', cwd: '/home/dev/projects/mission', prompt: 'go' }));
    expect(t.sessions.start).toHaveBeenCalledWith(expect.objectContaining({ server: 'cedar', cwd: '/home/dev/projects/mission', prompt: 'go', origin: 'manager' }));
    await t.actions.request(luady('session.interrupt', { sessionId: SID }));
    expect(t.sessions.interrupt).toHaveBeenCalledWith(SID);
    const restart = await t.actions.request(luady('session.restart', { sessionId: SID }));
    await t.actions.confirm(restart.id, GOOD_PIN, 'test-channel');
    const remove = await t.actions.request(luady('session.delete', { sessionId: SID }));
    await t.actions.confirm(remove.id, GOOD_PIN, 'test-channel');
    expect(t.sessions.restart).toHaveBeenCalledWith(SID);
    expect(t.sessions.remove).toHaveBeenCalledWith(SID);
    const logout = await t.actions.request({ kind: 'channel.unlink', actor: 'owner', channel: 'web', params: {}, pin: GOOD_PIN });
    expect(logout).toMatchObject({ status: 'done', result: 'chat channel unlinked' });
  });

  it('returns the terminal ticket only to the caller, bound to the caller\'s session, which is never stored', async () => {
    const t = setup();
    const dto = await t.actions.request({ kind: 'terminal.open', actor: 'owner', channel: 'web', params: { server: 'cedar' }, pin: GOOD_PIN, sid: 'sid-asking' });
    expect(dto.result).toMatch(/^[a-f0-9]{64}$/);
    expect(t.tickets.consume(dto.result ?? '', 'sid-asking')).toEqual({ server: 'cedar' });
    expect(JSON.stringify(t.actions.get(dto.id))).not.toContain('sid-asking');
    expect(t.actions.get(dto.id)?.result).toBe(TICKET_NOTE);
    expect(t.events.at(-1)?.result).toBe(TICKET_NOTE);
  });

  it('never stores or logs the PIN', async () => {
    const { log, lines } = createCaptureLogger();
    const t = setup({ log });
    await t.actions.request({ ...stopRequest(), actor: 'owner', channel: 'web', pin: GOOD_PIN });
    const pending = await t.actions.request(stopRequest());
    await t.actions.confirm(pending.id, GOOD_PIN, 'test-channel');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(GOOD_PIN);
    expect(JSON.stringify(t.db.prepare('SELECT * FROM actions').all())).not.toContain(GOOD_PIN);
    expect(JSON.stringify(t.events)).not.toContain(GOOD_PIN);
  });
});

describe('the manager answering a question of a session', () => {
  const QID = 'AAAAAAAA';
  const ANSWERS = { 'Which database?': 'Neither. First run the cleanup, then continue.' };
  function questionsStub(): Pick<QuestionService, 'check' | 'answer'> & { check: ReturnType<typeof vi.fn>; answer: ReturnType<typeof vi.fn> } {
    const dto = { qid: QID, sessionLabel: 'cedar · meadow-hr' } as ReturnType<QuestionService['check']>;
    return { check: vi.fn(() => dto), answer: vi.fn(async () => dto) };
  }
  const answerRequest = (): ActionRequest => luady('question.answer', { qid: QID, answers: ANSWERS });

  it('outside an owner turn waits for the PIN and types nothing into the session', async () => {
    const questions = questionsStub();
    const t = setup({ ownerTurn: false, questions });
    const dto = await t.actions.request(answerRequest());
    expect(dto).toMatchObject({ kind: 'question.answer', tier: 1, status: 'pending_confirmation' });
    expect(dto.summary.split('\n')).toEqual([
      expect.stringMatching(/^answer question #AAAAAAAA from cedar · meadow-hr \(\d+ characters, 2 lines, sha256 [0-9a-f]{12}\)$/),
      '| Neither. First run the cleanup, then continue.',
      '| (the answer to: Which database?)',
    ]);
    // The website's full text is the same composed text the summary hashed.
    expect(t.actions.fullText?.(dto.id)).toBe('Neither. First run the cleanup, then continue.\n(the answer to: Which database?)');
    expect(questions.check).toHaveBeenCalledWith(QID, ANSWERS);
    expect(questions.answer).not.toHaveBeenCalled();
    await t.actions.confirm(dto.id, GOOD_PIN, 'web');
    expect(questions.answer).toHaveBeenCalledWith(QID, ANSWERS, 'event');
  });

  it('in an owner turn is answered at once, like a message', async () => {
    const questions = questionsStub();
    const t = setup({ ownerTurn: true, questions });
    await expect(t.actions.request(answerRequest())).resolves.toMatchObject({ tier: 0, status: 'done', result: 'answered #AAAAAAAA (cedar · meadow-hr)' });
    expect(questions.answer).toHaveBeenCalledWith(QID, ANSWERS, 'event');
  });

  it('is refused at once when it does not fit the question (a PIN-shaped answer too), with no row', async () => {
    const questions = questionsStub();
    questions.check.mockImplementation(() => { throw new ValidationError('That answer looks like a PIN'); });
    const t = setup({ ownerTurn: false, questions });
    await expect(t.actions.request(answerRequest())).rejects.toBeInstanceOf(ValidationError);
    expect(t.actions.list({ limit: 10 })).toEqual([]);
  });
});

describe('the full text of an action', () => {
  it('is the whole message, line breaks kept and hidden characters marked; none for an action without text', async () => {
    const t = setup({ ownerTurn: false });
    const send = await t.actions.request(luady('session.send', { sessionId: SID, text: 'tidy up\nthen read the notes\u202e' }));
    expect(t.actions.fullText?.(send.id)).toBe('tidy up\nthen read the notes<U+202E>');
    const stop = await t.actions.request(stopRequest());
    expect(t.actions.fullText?.(stop.id)).toBeNull();
    expect(t.actions.fullText?.('A999')).toBeUndefined();
  });
});

describe('createActionService confirmation', () => {
  it('confirms a pending action with the PIN and executes it once', async () => {
    const t = setup();
    const pending = await t.actions.request(stopRequest());
    t.clock.advance(MINUTE);
    const done = await t.actions.confirm(pending.id, GOOD_PIN, 'test-channel');
    expect(t.pin.verify).toHaveBeenCalledWith(GOOD_PIN, 'test-channel');
    expect(t.sessions.stop).toHaveBeenCalledWith(SID, false);
    expect(done).toMatchObject({ status: 'done', result: 'stopped', decidedAt: '2026-10-09T12:01:00.000Z' });
    await expect(t.actions.confirm(pending.id, GOOD_PIN, 'web')).rejects.toBeInstanceOf(RefusedError);
  });

  it.for(PIN_ERRORS)('propagates $name unchanged and leaves the action pending', async ({ error }) => {
    const pin = createPinStub();
    vi.mocked(pin.verify).mockRejectedValue(error);
    const t = setup({ pin });
    const pending = await t.actions.request(stopRequest());
    await expect(t.actions.confirm(pending.id, '999999', 'test-channel')).rejects.toBe(error);
    expect(t.actions.get(pending.id)?.status).toBe('pending_confirmation');
    expect(t.sessions.stop).not.toHaveBeenCalled();
  });

  it('denies a pending action once', async () => {
    const t = setup();
    const pending = await t.actions.request(stopRequest());
    await expect(t.actions.deny(pending.id, 'test-channel')).resolves.toMatchObject({ status: 'denied', decidedAt: '2026-10-09T12:00:00.000Z' });
    await expect(t.actions.deny(pending.id, 'web')).rejects.toBeInstanceOf(RefusedError);
    await expect(t.actions.confirm(pending.id, GOOD_PIN, 'web')).rejects.toBeInstanceOf(RefusedError);
    expect(t.sessions.stop).not.toHaveBeenCalled();
  });

  it('refuses to confirm finished actions and reports unknown ones', async () => {
    const t = setup();
    const done = await t.actions.request(sendRequest());
    await expect(t.actions.confirm(done.id, GOOD_PIN, 'web')).rejects.toBeInstanceOf(RefusedError);
    await expect(t.actions.deny('A99', 'web')).rejects.toBeInstanceOf(NotFoundError);
    await expect(t.actions.confirm('bogus', GOOD_PIN, 'web')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('deny during PIN verification wins and nothing runs', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pin = createPinStub();
    vi.mocked(pin.verify).mockImplementation(async () => {
      await gate;
    });
    const t = setup({ pin });
    const pending = await t.actions.request(stopRequest());
    const confirming = t.actions.confirm(pending.id, GOOD_PIN, 'test-channel');
    await t.actions.deny(pending.id, 'web');
    release();
    await expect(confirming).rejects.toBeInstanceOf(RefusedError);
    expect(t.sessions.stop).not.toHaveBeenCalled();
    expect(t.actions.get(pending.id)?.status).toBe('denied');
  });

  it('two concurrent confirms execute the action once', async () => {
    const t = setup();
    const pending = await t.actions.request(stopRequest());
    const results = await Promise.allSettled([
      t.actions.confirm(pending.id, GOOD_PIN, 'web'),
      t.actions.confirm(pending.id, GOOD_PIN, 'test-channel'),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(RefusedError);
    expect(t.sessions.stop).toHaveBeenCalledTimes(1);
  });

  it('confirm after 30 minutes expires the action without checking the PIN', async () => {
    const t = setup();
    const pending = await t.actions.request(stopRequest());
    t.clock.advance(30 * MINUTE);
    await expect(t.actions.confirm(pending.id, GOOD_PIN, 'web')).rejects.toThrow('expired');
    expect(t.pin.verify).not.toHaveBeenCalled();
    expect(t.actions.get(pending.id)?.status).toBe('expired');
  });

  it('sweepExpired expires only pending actions that are 30 minutes old', async () => {
    const t = setup();
    const old = await t.actions.request(stopRequest());
    t.clock.advance(20 * MINUTE);
    const young = await t.actions.request(luady('session.restart', { sessionId: SID }));
    t.clock.advance(10 * MINUTE);
    expect(t.actions.sweepExpired()).toBe(1);
    expect(t.actions.get(old.id)?.status).toBe('expired');
    expect(t.actions.get(young.id)?.status).toBe('pending_confirmation');
    expect(t.actions.sweepExpired()).toBe(0);
    expect(t.events.at(-1)).toMatchObject({ id: old.id, status: 'expired', decidedAt: '2026-10-09T12:30:00.000Z' });
  });

  it('lists the audit log newest first', async () => {
    const t = setup();
    await t.actions.request(sendRequest());
    await t.actions.request(stopRequest());
    expect(t.actions.list({ limit: 10 }).map((action) => action.id)).toEqual(['A2', 'A1']);
    expect(t.actions.list({ status: 'done', limit: 10 }).map((action) => action.id)).toEqual(['A1']);
    expect(t.actions.get('A2')).toMatchObject({ status: 'pending_confirmation' });
    expect(t.actions.get('nope')).toBeUndefined();
  });
});

describe('an owner account change on the website (alwaysPin)', () => {
  it('needs the PIN even with PIN confirmations off, while Luady\u2019s own tier-1 actions still run at once', async () => {
    const t = setup({ requirePin: false });
    const owner = { kind: 'account.logout' as const, actor: 'owner' as const, channel: 'web' as const, params: { target: 'cedar' }, alwaysPin: true };
    await expect(t.actions.request({ ...owner, pin: '000000' })).rejects.toBeInstanceOf(PinInvalidError);
    const done = await t.actions.request(stopRequest());
    expect(done.status).toBe('done');
  });
});
