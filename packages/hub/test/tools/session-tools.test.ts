import { describe, expect, it, vi } from 'vitest';
import type { ActionDTO } from '@luady/shared';
import type { ToolContext } from '../../src/core/contracts.js';
import { NotFoundError, ValidationError } from '../../src/core/errors.js';
import { formatActionResult } from '../../src/tools/common.js';
import { REPORT_NOTE, SESSION_TOOLS, withReportNote } from '../../src/tools/session-tools.js';
import { SID, createFakeToolContext, makeAction, makeQuestion, makeSession } from './fake-context.js';

const PENDING_TEXT = 'pending_confirmation: action A7 — waiting for owner PIN (expires in 30 min).';

function withSessions(): ToolContext {
  const ctx = createFakeToolContext();
  vi.mocked(ctx.sessions.findByRef).mockImplementation((ref) => (ref === 'meadow-hr' || ref === SID ? makeSession() : undefined));
  vi.mocked(ctx.sessions.list).mockReturnValue([
    makeSession(),
    makeSession({ id: 'birch:cc-orchard:0.0', host: 'birch', target: 'cc-orchard:0.0', displayName: 'orchard' }),
  ]);
  return ctx;
}

const TIER1_TOOLS: Array<{
  tool: 'session_stop' | 'session_restart' | 'session_delete';
  input: Record<string, unknown>;
  kind: string;
  params: Record<string, unknown>;
}> = [
  { tool: 'session_stop', input: { session: 'meadow-hr', reason: 'task done' }, kind: 'session.stop', params: { sessionId: SID, force: false, reason: 'task done' } },
  { tool: 'session_restart', input: { session: 'meadow-hr', reason: 'stuck turn' }, kind: 'session.restart', params: { sessionId: SID, reason: 'stuck turn' } },
  { tool: 'session_delete', input: { session: 'meadow-hr', reason: 'old mission' }, kind: 'session.delete', params: { sessionId: SID, reason: 'old mission' } },
];

const RESULT_TEXTS: Array<{ status: ActionDTO['status']; text: string }> = [
  { status: 'pending_confirmation', text: PENDING_TEXT },
  { status: 'done', text: 'done: action A7 — stopped' },
  { status: 'failed', text: 'failed: action A7 — boom' },
  { status: 'denied', text: 'denied: action A7' },
  { status: 'expired', text: 'expired: action A7' },
];

describe('session tools', () => {
  it('session_read returns the condensed transcript under a header', async () => {
    const ctx = withSessions();
    vi.mocked(ctx.sessions.condensed).mockResolvedValue('user: hi\nassistant: hello');
    await expect(SESSION_TOOLS.session_read({ session: 'meadow-hr' }, ctx)).resolves.toBe('cedar · meadow-hr · idle\nuser: hi\nassistant: hello');
    expect(ctx.sessions.condensed).toHaveBeenCalledWith(SID, 20);
  });

  it('explains an unknown session with close matches', async () => {
    const ctx = withSessions();
    await expect(SESSION_TOOLS.session_read({ session: 'meadow-h' }, ctx)).rejects.toThrow(
      'Unknown session "meadow-h". Did you mean: cedar/meadow-hr (cedar:cc-meadow-hr:0.0)',
    );
    await expect(SESSION_TOOLS.session_send({ session: 'zzz', text: 'x' }, ctx)).rejects.toThrow(
      'Known sessions: cedar/meadow-hr (cedar:cc-meadow-hr:0.0), birch/orchard (birch:cc-orchard:0.0)',
    );
  });

  it('refuses the brain session even when findByRef returns it', async () => {
    const ctx = withSessions();
    vi.mocked(ctx.sessions.findByRef).mockReturnValue(
      makeSession({ id: 'hq:manager:0.0', host: 'hq', target: 'manager:0.0', displayName: 'manager', origin: 'system' }),
    );
    await expect(SESSION_TOOLS.session_stop({ session: 'manager', reason: 'restart me' }, ctx)).rejects.toBeInstanceOf(NotFoundError);
    expect(ctx.actions.request).not.toHaveBeenCalled();
  });

  it('session_send goes through actions.request as Luady', async () => {
    const ctx = withSessions();
    vi.mocked(ctx.actions.request).mockResolvedValue(makeAction({ id: 'A3', kind: 'session.send', tier: 0, status: 'done', result: 'sent' }));
    await expect(SESSION_TOOLS.session_send({ session: 'meadow-hr', text: 'continue' }, ctx)).resolves.toBe('done: action A3 — sent');
    expect(ctx.actions.request).toHaveBeenCalledWith({
      kind: 'session.send',
      actor: 'manager',
      channel: 'event',
      params: { sessionId: SID, text: `continue${REPORT_NOTE}` },
    });
  });

  it('tells every session how to report a result mid-turn, once and within the length limit', () => {
    expect(REPORT_NOTE).toContain('~/.luady/bin/luady-report');
    expect(withReportNote('make a fresh account')).toBe(`make a fresh account${REPORT_NOTE}`);
    expect(withReportNote(`again${REPORT_NOTE}`)).toBe(`again${REPORT_NOTE}`);
    const long = 'x'.repeat(19_990);
    expect(withReportNote(long)).toBe(long);
  });

  it('session_start leaves out an empty prompt', async () => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.actions.request).mockResolvedValue(
      makeAction({ id: 'A4', kind: 'session.start', tier: 0, status: 'done', result: 'started cedar:cc-audit:0.0 (audit)' }),
    );
    await expect(SESSION_TOOLS.session_start({ server: 'cedar', cwd: '/home/dev/projects/meadow-hr', name: 'audit' }, ctx)).resolves.toBe(
      'done: action A4 — started cedar:cc-audit:0.0 (audit)',
    );
    expect(ctx.actions.request).toHaveBeenCalledWith({
      kind: 'session.start',
      actor: 'manager',
      channel: 'event',
      params: { server: 'cedar', cwd: '/home/dev/projects/meadow-hr', name: 'audit' },
    });
  });

  it('session_start adds the report note to a first prompt', async () => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.actions.request).mockResolvedValue(makeAction({ id: 'A5', kind: 'session.start', tier: 0, status: 'done', result: 'started' }));
    await SESSION_TOOLS.session_start({ server: 'cedar', cwd: '/home/dev/projects/meadow-hr', prompt: 'audit the API' }, ctx);
    expect(ctx.actions.request).toHaveBeenCalledWith(expect.objectContaining({
      params: { server: 'cedar', cwd: '/home/dev/projects/meadow-hr', prompt: `audit the API${REPORT_NOTE}` },
    }));
  });

  it('session_start rejects a cwd outside /home/dev/projects', async () => {
    await expect(SESSION_TOOLS.session_start({ server: 'cedar', cwd: '/etc' }, createFakeToolContext())).rejects.toBeInstanceOf(ValidationError);
  });

  it('session_interrupt goes through actions.request', async () => {
    const ctx = withSessions();
    vi.mocked(ctx.actions.request).mockResolvedValue(makeAction({ id: 'A5', kind: 'session.interrupt', tier: 0, status: 'done', result: 'interrupted' }));
    await expect(SESSION_TOOLS.session_interrupt({ session: SID }, ctx)).resolves.toBe('done: action A5 — interrupted');
    expect(ctx.actions.request).toHaveBeenCalledWith({ kind: 'session.interrupt', actor: 'manager', channel: 'event', params: { sessionId: SID } });
  });

  it.for(TIER1_TOOLS)('$tool waits for the owner PIN', async ({ tool, input, kind, params }) => {
    const ctx = withSessions();
    vi.mocked(ctx.actions.request).mockResolvedValue(makeAction());
    await expect(SESSION_TOOLS[tool](input, ctx)).resolves.toBe(PENDING_TEXT);
    expect(ctx.actions.request).toHaveBeenCalledWith({ kind, actor: 'manager', channel: 'event', params });
  });

  it('question_list shows every pending question in full with numbered options', async () => {
    const ctx = createFakeToolContext();
    await expect(SESSION_TOOLS.question_list({}, ctx)).resolves.toBe('No pending questions.');
    vi.mocked(ctx.questions.pending).mockReturnValue([makeQuestion({
      questions: [
        { question: 'Which database should I use?', options: [{ label: 'Postgres', description: 'robust' }, { label: 'MySQL' }] },
        { question: 'Which features?', multiSelect: true, options: [{ label: 'Login' }, { label: 'Search' }] },
      ],
    })]);
    await expect(SESSION_TOOLS.question_list({}, ctx)).resolves.toBe([
      '#AAAAAAAA · cedar · meadow-hr',
      '1. Which database should I use?', '   1) Postgres', '   2) MySQL',
      '2. Which features? (several allowed)', '   1) Login', '   2) Search',
    ].join('\n'));
  });

  it('question_answer asks the action service (the PIN outside an owner turn); question_release goes to QuestionService', async () => {
    const ctx = createFakeToolContext();
    vi.mocked(ctx.questions.release).mockResolvedValue(makeQuestion({ state: 'released' }));
    const answers = { 'Which database should I use?': 'Postgres' };
    await SESSION_TOOLS.question_answer({ qid: 'AAAAAAAA', answers }, ctx);
    expect(ctx.actions.request).toHaveBeenCalledWith({ kind: 'question.answer', actor: 'manager', channel: 'event', params: { qid: 'AAAAAAAA', answers } });
    expect(ctx.questions.answer).not.toHaveBeenCalled();
    await expect(SESSION_TOOLS.question_release({ qid: 'AAAAAAAA' }, ctx)).resolves.toBe(
      'released #AAAAAAAA (cedar · meadow-hr) to the terminal dialog',
    );
    expect(ctx.questions.release).toHaveBeenCalledWith('AAAAAAAA', 'event');
  });

  it('question tools reject a malformed qid', async () => {
    await expect(SESSION_TOOLS.question_release({ qid: 'abc' }, createFakeToolContext())).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('formatActionResult', () => {
  it.for(RESULT_TEXTS)('$status', ({ status, text }) => {
    const dto = makeAction({ status, result: status === 'done' ? 'stopped' : null, error: status === 'failed' ? 'boom' : null });
    expect(formatActionResult(dto)).toBe(text);
  });
});
