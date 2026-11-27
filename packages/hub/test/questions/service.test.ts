import { describe, expect, it, vi } from 'vitest';
import { HIDDEN_COMMAND_NOTE } from '@luady/shared';
import type {
  CtlPending, PermissionAnswerFile, PermissionPreview, QuestionAnswerFile, QuestionDTO, SessionDTO, SpoolEvent,
} from '@luady/shared';
import { createBus } from '../../src/core/bus.js';
import { CtlError, NotFoundError, QuestionClosedError, ValidationError } from '../../src/core/errors.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createMemoryService } from '../../src/memory/service.js';
import { createQuestionService } from '../../src/questions/service.js';
import { PIN_ANSWER_MESSAGE } from '../../src/questions/validate.js';
import { createFakeClock, createFakeCtl, silentLogger } from '../helpers/fakes.js';
import { createFakeFleet, serverDto } from '../fleet/fake-fleet.js';
import { permission, permissionResolved, permissionWithPreview, question, questionResolved } from '../sessions/spool-events.js';

const QID = 'QQQQ2345';
const PID = 'PPPP2345';
const SESSION_ID = 'cedar:cc-meadow-hr:0.0';
const DB_QUESTION = {
  question: 'Which database?',
  header: 'DB',
  multiSelect: false,
  options: [{ label: 'Postgres', description: 'managed' }, { label: 'SQLite' }],
};
const TESTS_QUESTION = { question: 'Add tests?', options: [{ label: 'Yes' }, { label: 'No' }] };
const QUESTIONS = [DB_QUESTION, TESTS_QUESTION];
const ENDED_SESSION: SessionDTO = {
  id: SESSION_ID,
  host: 'cedar',
  target: 'cc-meadow-hr:0.0',
  claudeSessionId: 'claude-a',
  cwd: '/home/dev/projects/meadow-hr',
  project: 'meadow-hr',
  displayName: 'meadow-hr',
  state: 'ended',
  origin: 'owner',
  registered: true,
  lastEventAt: null,
  turnStartedAt: null,
  pendingQid: null,
  unexpectedEnd: true,
};
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const db = openMemoryDb();
  const bus = createBus();
  const clock = createFakeClock('2026-10-09T12:00:00.000Z');
  const answers: Array<{ qid: string; payload: QuestionAnswerFile }> = [];
  const permissions: Array<{ qid: string; payload: PermissionAnswerFile }> = [];
  const state: { answerImpl: () => Promise<void>; permissionImpl: () => Promise<void>; serverPending: CtlPending['pending'] } = {
    answerImpl: async () => undefined,
    permissionImpl: async () => undefined,
    serverPending: [],
  };
  const ctl = createFakeCtl({
    answer: async (qid, payload) => {
      answers.push({ qid, payload });
      await state.answerImpl();
    },
    permission: async (qid, payload) => {
      permissions.push({ qid, payload });
      await state.permissionImpl();
    },
    pending: async () => ({ pending: state.serverPending }),
  });
  const memory = createMemoryService({ db, clock });
  const service = createQuestionService({ db, bus, clock, fleet: createFakeFleet({ cedar: ctl }), memory, log: silentLogger() });
  const updates: QuestionDTO[] = [];
  bus.on('question.updated', (dto) => updates.push(dto));
  service.start();
  const ingest = (event: SpoolEvent): void => bus.emit('spool.event', { host: 'cedar', event, replay: false });
  return { db, bus, clock, answers, permissions, state, memory, service, updates, ingest };
}

describe('createQuestionService', () => {
  it('records a pending question from a spool event', () => {
    const { service, updates, ingest, memory } = setup();
    ingest(question(QID, QUESTIONS, { ts: '2026-10-09T11:59:00Z' }));
    expect(service.pending()).toEqual([
      {
        qid: QID,
        kind: 'question',
        host: 'cedar',
        sessionId: SESSION_ID,
        sessionLabel: 'cedar · meadow-hr',
        questions: QUESTIONS,
        permission: null,
        state: 'pending',
        createdAt: '2026-10-09T11:59:00.000Z',
        resolvedAt: null,
        resolvedVia: null,
      },
    ]);
    expect(updates).toHaveLength(1);
    expect(memory.search('database', 5)).toEqual([expect.objectContaining({ thread: `session:${SESSION_ID}`, role: 'assistant' })]);
    ingest(question(QID, QUESTIONS));
    expect(updates).toHaveLength(1);
  });

  it('records permission requests', () => {
    const { service, ingest } = setup();
    ingest(permission(PID, 'Bash', 'rm -rf build'));
    expect(service.get(PID)).toMatchObject({
      kind: 'permission',
      questions: [],
      permission: { toolName: 'Bash', inputPreview: 'rm -rf build' },
      state: 'pending',
    });
  });

  it('answer validates keys and values before calling luady-ctl', async () => {
    const { service, ingest, answers } = setup();
    ingest(question(QID, QUESTIONS));
    await expect(service.answer(QID, { 'Which database?': 'Postgres' }, 'test-channel')).rejects.toThrow(/missing answer/);
    await expect(service.answer(QID, { 'Which database?': 'Postgres', 'Add tests?': 'Yes', Extra: 'x' }, 'test-channel')).rejects.toBeInstanceOf(ValidationError);
    await expect(service.answer(QID, { 'Which database?': '  ', 'Add tests?': 'Yes' }, 'test-channel')).rejects.toBeInstanceOf(ValidationError);
    await expect(service.answer('ZZZZ2345', {}, 'web')).rejects.toBeInstanceOf(NotFoundError);
    expect(answers).toEqual([]);
    expect(service.get(QID)?.state).toBe('pending');
  });

  it('answer delivers through luady-ctl and marks the question answered', async () => {
    const { service, ingest, answers, updates, clock, memory } = setup();
    ingest(question(QID, QUESTIONS));
    clock.advance(30_000);
    const dto = await service.answer(QID, { 'Which database?': 'Postgres', 'Add tests?': 'Yes, with vitest' }, 'test-channel');
    expect(answers).toEqual([{ qid: QID, payload: { answers: { 'Which database?': 'Postgres', 'Add tests?': 'Yes, with vitest' } } }]);
    expect(dto).toMatchObject({ state: 'answered', resolvedVia: 'test-channel', resolvedAt: '2026-10-09T12:00:30.000Z' });
    expect(updates.at(-1)?.state).toBe('answered');
    expect(memory.search('vitest', 5)).toEqual([expect.objectContaining({ role: 'owner', thread: `session:${SESSION_ID}` })]);
  });

  it('answer on non-pending throws QuestionClosedError', async () => {
    const { service, ingest, answers } = setup();
    ingest(question(QID, [TESTS_QUESTION]));
    await service.answer(QID, { 'Add tests?': 'Yes' }, 'test-channel');
    const second = await service.answer(QID, { 'Add tests?': 'No' }, 'web').catch((err: unknown) => err);
    expect(second).toBeInstanceOf(QuestionClosedError);
    expect(second).toMatchObject({ state: 'answered' });
    ingest(question('TTTT2345', [TESTS_QUESTION]));
    ingest(questionResolved('TTTT2345', 'timeout'));
    await expect(service.answer('TTTT2345', { 'Add tests?': 'Yes' }, 'test-channel')).rejects.toMatchObject({ name: 'QuestionClosedError', state: 'timeout' });
    await expect(service.release('TTTT2345', 'web')).rejects.toBeInstanceOf(QuestionClosedError);
    expect(answers).toHaveLength(1);
  });

  it('concurrent answers deliver exactly once', async () => {
    const env = setup();
    env.ingest(question(QID, [TESTS_QUESTION]));
    let releaseDelivery: () => void = () => undefined;
    env.state.answerImpl = () => new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const first = env.service.answer(QID, { 'Add tests?': 'Yes' }, 'test-channel');
    const second = env.service.answer(QID, { 'Add tests?': 'Yes' }, 'web');
    await vi.waitFor(() => expect(env.answers).toHaveLength(1));
    releaseDelivery();
    const results = await Promise.allSettled([first, second]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(QuestionClosedError);
    expect(env.answers).toHaveLength(1);
  });

  it('reverts to pending when delivery fails', async () => {
    const env = setup();
    env.ingest(question(QID, [TESTS_QUESTION]));
    env.state.answerImpl = async () => {
      throw new CtlError('unreachable', 'cedar is not connected', -1);
    };
    await expect(env.service.answer(QID, { 'Add tests?': 'Yes' }, 'test-channel')).rejects.toMatchObject({ code: 'unreachable' });
    expect(env.service.get(QID)).toMatchObject({ state: 'pending', resolvedVia: null, resolvedAt: null });
  });

  it('treats not_found from luady-ctl as a closed question', async () => {
    const env = setup();
    env.ingest(question(QID, [TESTS_QUESTION]));
    env.state.answerImpl = async () => {
      throw new CtlError('not_found', 'no pending question QQQQ2345', 4);
    };
    await expect(env.service.answer(QID, { 'Add tests?': 'Yes' }, 'web')).rejects.toMatchObject({ name: 'QuestionClosedError', state: 'timeout' });
    expect(env.service.get(QID)?.state).toBe('timeout');
  });

  it('release and answerPermission use the right verbs', async () => {
    const { service, ingest, answers, permissions } = setup();
    ingest(question(QID, [TESTS_QUESTION]));
    ingest(permission(PID, 'Bash', 'rm -rf build'));
    await expect(service.answerPermission(QID, 'allow', undefined, 'web')).rejects.toBeInstanceOf(ValidationError);
    await expect(service.answer(PID, {}, 'web')).rejects.toBeInstanceOf(ValidationError);
    await expect(service.release(QID, 'web')).resolves.toMatchObject({ state: 'released', resolvedVia: 'web' });
    expect(answers).toEqual([{ qid: QID, payload: { release: true } }]);
    await expect(service.answerPermission(PID, 'deny', 'not on prod', 'test-channel')).resolves.toMatchObject({ state: 'answered' });
    expect(permissions).toEqual([{ qid: PID, payload: { behavior: 'deny', message: 'not on prod' } }]);
  });

  it('resolved events finalize the state', () => {
    const { service, ingest } = setup();
    ingest(question('AAAA2345', [TESTS_QUESTION]));
    ingest(question('BBBB2345', [TESTS_QUESTION]));
    ingest(permission(PID, 'Bash', 'ls'));
    ingest(questionResolved('AAAA2345', 'timeout', { ts: '2026-10-09T16:00:00Z' }));
    ingest(questionResolved('BBBB2345', 'error'));
    ingest(permissionResolved(PID, 'allowed'));
    expect(service.get('AAAA2345')).toMatchObject({ state: 'timeout', resolvedVia: 'timeout', resolvedAt: '2026-10-09T16:00:00.000Z' });
    expect(service.get('BBBB2345')).toMatchObject({ state: 'released', resolvedVia: 'error' });
    expect(service.get(PID)).toMatchObject({ state: 'answered', resolvedVia: 'allowed' });
    expect(service.pending()).toEqual([]);
  });

  it('never delivers or stores an answer that looks like a PIN, unless it is one of the offered labels', async () => {
    const { service, ingest, answers, permissions, memory } = setup();
    ingest(question(QID, [{ question: 'Enter the code', options: [] }]));
    ingest(permission(PID, 'Bash', 'npm test'));
    await expect(service.answer(QID, { 'Enter the code': ' 482913 ' }, 'web')).rejects.toThrow(PIN_ANSWER_MESSAGE);
    // The refusal says how to send a real code: a word in front of it, which is then delivered.
    expect(PIN_ANSWER_MESSAGE).toContain('put a word in front of it');
    expect(() => service.check(QID, { 'Enter the code': 'code 482913' })).not.toThrow();
    await expect(service.answer(QID, { 'Enter the code': '٤٨٢٩١٣' }, 'event')).rejects.toBeInstanceOf(ValidationError);
    await expect(service.answerPermission(PID, 'deny', '482913', 'web')).rejects.toThrow(PIN_ANSWER_MESSAGE);
    expect(answers).toEqual([]);
    expect(permissions).toEqual([]);
    expect(memory.search('482913', 5)).toEqual([]);
    expect(service.get(QID)?.state).toBe('pending');
    ingest(question('LABEL234', [{ question: 'Port?', options: [{ label: '808080' }, { label: '9090' }] }]));
    await expect(service.answer('LABEL234', { 'Port?': '808080' }, 'web')).resolves.toMatchObject({ state: 'answered' });
  });

  it('a resolved event closes only a question of the host that sent it', () => {
    const { bus, service, ingest, db } = setup();
    ingest(question(QID, [TESTS_QUESTION]));
    ingest(permissionWithPreview(PID, 'Edit', '{}', EDIT_PREVIEW));
    const fromBirch = (event: SpoolEvent): void => bus.emit('spool.event', { host: 'birch', event, replay: false });
    fromBirch(questionResolved(QID, 'answered'));
    fromBirch(permissionResolved(PID, 'denied'));
    expect(service.get(QID)).toMatchObject({ state: 'pending', resolvedVia: null });
    expect(service.get(PID)).toMatchObject({ state: 'pending', permission: { preview: EDIT_PREVIEW } });
    expect(payloadKeys(db, PID)).toContain('preview');
    ingest(questionResolved(QID, 'answered'));
    expect(service.get(QID)?.state).toBe('answered');
  });

  it('a host counts as reconciled only once its pending questions were compared since the hub started', async () => {
    const env = setup();
    expect(env.service.reconciled('cedar')).toBe(false);
    env.bus.emit('server.updated', serverDto('cedar', 'online'));
    await settle();
    expect(env.service.reconciled('cedar')).toBe(true);
    expect(env.service.reconciled('birch')).toBe(false);
  });

  it('reconciles pending questions when a server comes online', async () => {
    const env = setup();
    env.ingest(question('GONE2345', [TESTS_QUESTION], { ts: '2026-10-09T11:55:00Z' }));
    env.ingest(question('LIVE2345', [TESTS_QUESTION], { ts: '2026-10-09T11:55:00Z' }));
    env.ingest(question('NEWW2345', [TESTS_QUESTION], { ts: '2026-10-09T12:00:00Z' }));
    env.state.serverPending = [
      { qid: 'LIVE2345', kind: 'question', created_at: '2026-10-09T11:55:00Z', session_id: 'claude-a', tmux: 'cc-meadow-hr:0.0' },
    ];
    env.bus.emit('server.updated', serverDto('cedar', 'online'));
    await settle();
    expect(env.service.get('GONE2345')).toMatchObject({ state: 'timeout', resolvedVia: 'reconcile' });
    expect(env.service.get('LIVE2345')?.state).toBe('pending');
    expect(env.service.get('NEWW2345')?.state).toBe('pending');
    env.state.serverPending = [];
    env.bus.emit('server.updated', serverDto('cedar', 'online'));
    await settle();
    expect(env.service.get('LIVE2345')?.state).toBe('pending');
  });

  it('closes pending questions of a session that ended', () => {
    const env = setup();
    env.ingest(question(QID, [TESTS_QUESTION]));
    env.bus.emit('session.ended', { session: ENDED_SESSION, unexpected: true, reason: 'pane_gone', replay: false });
    expect(env.service.get(QID)).toMatchObject({ state: 'timeout', resolvedVia: 'session_ended' });
  });

  it('markNotified and markEscalated stamp the row', () => {
    const { service, ingest, db, clock } = setup();
    ingest(question(QID, [TESTS_QUESTION]));
    service.markNotified(QID);
    clock.advance(600_000);
    service.markEscalated(QID);
    expect(db.prepare('SELECT notified_at, escalated_at FROM questions WHERE qid = ?').get(QID)).toEqual({
      notified_at: '2026-10-09T12:00:00.000Z',
      escalated_at: '2026-10-09T12:10:00.000Z',
    });
  });
});

const EDIT_PREVIEW: PermissionPreview = {
  tool: 'Edit', kind: 'edit', command: null, path: '/var/www/app/index.php', cwd: '/home/dev/projects/meadow-hr',
  edits: [{ old: 'a', new: 'b' }], truncated: false, always: { label: 'Edit files in /var/www/app this session' },
};
const BASH_PREVIEW: PermissionPreview = {
  tool: 'Bash', kind: 'command', command: 'npm test', path: null, cwd: '/home/dev/projects/meadow-hr',
  edits: [], truncated: false, always: null,
};

function payloadKeys(db: ReturnType<typeof openMemoryDb>, qid: string): string[] {
  const row = db.prepare('SELECT payload_json FROM questions WHERE qid = ?').get(qid) as { payload_json: string };
  return Object.keys(JSON.parse(row.payload_json) as Record<string, unknown>);
}

describe('permission previews', () => {
  it('a permission event with a preview gives a pending DTO with the preview and a risk mark', () => {
    const { service, ingest, db } = setup();
    ingest(permissionWithPreview(PID, 'Edit', '{"file_path":"/var/www/app/index.php"}', EDIT_PREVIEW));
    expect(service.get(PID)?.permission).toEqual({
      toolName: 'Edit', inputPreview: '{"file_path":"/var/www/app/index.php"}', preview: EDIT_PREVIEW,
      risk: { level: 'risky', reason: 'touches production' },
    });
    expect(payloadKeys(db, PID)).toContain('preview');
  });

  it('a kit-1 permission event has preview null and a risk from the legacy string', () => {
    const { service, ingest } = setup();
    ingest(permission(PID, 'Bash', 'rm -rf build'));
    expect(service.get(PID)?.permission).toEqual({
      toolName: 'Bash', inputPreview: 'rm -rf build', preview: null, risk: { level: 'risky', reason: 'deletes files' },
    });
  });

  it('allow always sends always: true to the kit and notes it for the rest of the session', async () => {
    const { service, ingest, permissions, memory } = setup();
    ingest(permissionWithPreview(PID, 'Edit', '{}', EDIT_PREVIEW));
    await expect(service.answerPermission(PID, 'allow', undefined, 'web', { always: true })).resolves.toMatchObject({ state: 'answered' });
    expect(permissions).toEqual([{ qid: PID, payload: { behavior: 'allow', always: true } }]);
    expect(memory.search('rest of the session', 5)).toEqual([expect.objectContaining({ text: `↩ #${PID} allowed for the rest of the session` })]);
  });

  it('allow always is refused with deny, and when the preview does not offer it', async () => {
    const { service, ingest, permissions } = setup();
    ingest(permissionWithPreview(PID, 'Edit', '{}', EDIT_PREVIEW));
    await expect(service.answerPermission(PID, 'deny', undefined, 'web', { always: true }))
      .rejects.toThrow(new ValidationError('Allow always goes with Allow'));
    ingest(permissionWithPreview('BASH2345', 'Bash', 'npm test', BASH_PREVIEW));
    await expect(service.answerPermission('BASH2345', 'allow', undefined, 'web', { always: true }))
      .rejects.toThrow(new ValidationError('Allow always is not offered for this request'));
    ingest(permission('LEGA2345', 'Bash', 'npm test'));
    await expect(service.answerPermission('LEGA2345', 'allow', undefined, 'web', { always: true }))
      .rejects.toBeInstanceOf(ValidationError);
    expect(permissions).toEqual([]);
    expect(service.get(PID)?.state).toBe('pending');
  });

  it('allow is refused, with the reason, when part of the command is hidden; deny and release still work', async () => {
    const { service, ingest, permissions } = setup();
    const hidden = { ...BASH_PREVIEW, command: 'export TOKEN=[redacted]', allow: false };
    ingest(permissionWithPreview(PID, 'Bash', 'export TOKEN=[redacted]', hidden));
    await expect(service.answerPermission(PID, 'allow', undefined, 'web')).rejects.toThrow(new ValidationError(HIDDEN_COMMAND_NOTE));
    await expect(service.answerPermission(PID, 'allow', undefined, 'web', { always: true })).rejects.toThrow(new ValidationError(HIDDEN_COMMAND_NOTE));
    ingest(permission('LEGA2345', 'Bash', 'curl -u bob:[redacted] https://x.test'));
    await expect(service.answerPermission('LEGA2345', 'allow', undefined, 'phone')).rejects.toThrow(new ValidationError(HIDDEN_COMMAND_NOTE));
    expect(permissions).toEqual([]);
    await expect(service.answerPermission(PID, 'deny', 'no', 'web')).resolves.toMatchObject({ state: 'answered' });
    await expect(service.release('LEGA2345', 'web')).resolves.toMatchObject({ state: 'released' });
    expect(permissions).toEqual([{ qid: PID, payload: { behavior: 'deny', message: 'no' } }, { qid: 'LEGA2345', payload: { release: true } }]);
  });

  it('allow is refused for any request shown cut or redacted: a file change, an MCP tool, a kit-1 line', async () => {
    const { service, ingest, permissions } = setup();
    const REQUEST = 'Part of this request is hidden. Answer it in the terminal, where you can see all of it.';
    ingest(permissionWithPreview('WRIT2345', 'Write', '{}', { ...EDIT_PREVIEW, tool: 'Write', kind: 'write', truncated: true }));
    ingest(permissionWithPreview('MCPX2345', 'mcp__shell__run_command', `${'x'.repeat(1999)}…`, {
      ...BASH_PREVIEW, tool: 'mcp__shell__run_command', kind: 'other', command: null,
    }));
    ingest(permission('KIT12345', 'Write', '{"content": "TOKEN=[redacted]", "file_path": "/w/.env"}'));
    for (const qid of ['WRIT2345', 'MCPX2345', 'KIT12345']) {
      await expect(service.answerPermission(qid, 'allow', undefined, 'web'), qid).rejects.toThrow(new ValidationError(REQUEST));
    }
    expect(permissions).toEqual([]);
    ingest(permissionWithPreview('MCPY2345', 'mcp__jira__create', '{"summary": "Fix the login page"}', {
      ...BASH_PREVIEW, tool: 'mcp__jira__create', kind: 'other', command: null,
    }));
    await expect(service.answerPermission('MCPY2345', 'allow', undefined, 'web')).resolves.toMatchObject({ state: 'answered' });
  });

  it('a delivery that fails keeps the preview and the question pending', async () => {
    const env = setup();
    env.ingest(permissionWithPreview(PID, 'Edit', '{}', EDIT_PREVIEW));
    env.state.permissionImpl = async () => {
      throw new CtlError('unreachable', 'cedar is not connected', -1);
    };
    await expect(env.service.answerPermission(PID, 'allow', undefined, 'web')).rejects.toMatchObject({ code: 'unreachable' });
    expect(env.service.get(PID)).toMatchObject({ state: 'pending', permission: { preview: EDIT_PREVIEW } });
    expect(payloadKeys(env.db, PID)).toContain('preview');
  });

  const CLOSERS: Array<[string, (env: ReturnType<typeof setup>) => Promise<unknown>]> = [
    ['an answer', (env) => env.service.answerPermission(PID, 'deny', 'no', 'web')],
    ['a release', (env) => env.service.release(PID, 'web')],
    ['a permission_resolved event', async (env) => env.ingest(permissionResolved(PID, 'allowed'))],
    ['a reconcile timeout', async (env) => {
      env.bus.emit('server.updated', serverDto('cedar', 'online'));
      await settle();
    }],
    ['a session end', async (env) => env.bus.emit('session.ended', { session: ENDED_SESSION, unexpected: true, reason: 'pane_gone', replay: false })],
    ['an answer to a request the kit no longer holds', (env) => {
      env.state.permissionImpl = async () => {
        throw new CtlError('not_found', 'no pending permission', 4);
      };
      return env.service.answerPermission(PID, 'allow', undefined, 'web').catch(() => undefined);
    }],
  ];

  it.each(CLOSERS)('the stored preview is gone after %s and the published DTO has preview null', async (_name, close) => {
    const env = setup();
    env.ingest(permissionWithPreview(PID, 'Edit', '{}', EDIT_PREVIEW, { ts: '2026-10-09T11:55:00Z' }));
    await close(env);
    expect(env.service.get(PID)?.state).not.toBe('pending');
    expect(payloadKeys(env.db, PID)).not.toContain('preview');
    expect(env.updates.at(-1)).toMatchObject({ qid: PID, permission: { preview: null } });
    expect(env.service.get(PID)?.permission?.preview).toBeNull();
  });
});
