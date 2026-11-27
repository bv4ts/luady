import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type QuestionDTO, type Settings } from '@luady/shared';
import type { QuestionService } from '../../src/core/contracts.js';
import {
  NotFoundError, PinInvalidError, PinLockedError, PinNotSetError, QuestionClosedError, QuestionPendingError, RefusedError,
} from '../../src/core/errors.js';
import { runCommand, type CommandDeps } from '../../src/inbound/commands.js';
import { noticeForError } from '../../src/inbound/errors.js';
import { GENERIC_ERROR_NOTICE, LOCAL_USAGE, PIN_NOT_SET_NOTICE, helpText } from '../../src/notify/format.js';
import { createFakeOutbound, silentLogger, classicHostLookups } from '../../test/helpers/fakes.js';

const T0 = '2026-10-09T12:00:00.000Z';

function pendingQuestion(qid: string, kind: QuestionDTO['kind']): QuestionDTO {
  return {
    qid, kind, host: 'cedar', sessionId: 'cedar:cc-meadow-hr:0.0', sessionLabel: 'meadow-hr',
    questions: kind === 'question' ? [{ question: 'Which DB?', options: [{ label: 'Postgres' }] }] : [],
    permission: kind === 'permission' ? { toolName: 'Bash', inputPreview: 'rm -rf build' } : null,
    state: 'pending', createdAt: T0, resolvedAt: null, resolvedVia: null,
  };
}

interface SetupOptions {
  missions?: string[];
  phoneEnabled?: boolean;
  pending?: QuestionDTO[];
  release?: QuestionService['release'];
}

function setup(opts: SetupOptions = {}) {
  const outbound = createFakeOutbound();
  const replies: string[] = [];
  let settings: Settings = { ...DEFAULT_SETTINGS };
  const update = vi.fn((patch: Partial<Settings>) => {
    settings = { ...settings, ...patch };
    return settings;
  });
  const callOwner = vi.fn(async (_reason: string): Promise<void> => undefined);
  const defaultRelease: QuestionService['release'] = async (qid) => ({ ...pendingQuestion(qid, 'question'), state: 'released' });
  const release = vi.fn(opts.release ?? defaultRelease);
  const sentElsewhere = vi.fn();
  const deps: CommandDeps = {
    channel: 'test-channel',
    log: silentLogger(),
    outbound,
    notices: { sentElsewhere },
    questions: {
      pending: () => opts.pending ?? [], get: vi.fn(), answer: vi.fn(), answerPermission: vi.fn(), release,
      markNotified: vi.fn(), markEscalated: vi.fn(),
    },
    sessions: {
      list: () => [], get: () => undefined, findByRef: () => undefined, send: vi.fn(), interrupt: vi.fn(), start: vi.fn(),
      stop: vi.fn(), restart: vi.fn(), remove: vi.fn(), transcript: vi.fn(), condensed: vi.fn(),
    },
    actions: {
      request: vi.fn(), confirm: vi.fn(), deny: vi.fn(), get: vi.fn(), list: vi.fn(), pending: () => [], sweepExpired: vi.fn(),
    },
    luady: {
      status: () => ({ state: 'running', since: T0, claudeSessionId: null, queued: 0 }), start: vi.fn(), stop: vi.fn(),
      postOwnerMessage: vi.fn(), postEvent: vi.fn(), messages: vi.fn(),
    },
    settings: { get: () => settings, update },
    missions: { list: () => opts.missions ?? [] },
    phone: { enabled: () => opts.phoneEnabled ?? false, callForQuestion: vi.fn(), callOwner },
    fleet: {
      start: vi.fn(), stop: vi.fn(), client: vi.fn(), openShell: vi.fn(), ...classicHostLookups(), tailEvents: vi.fn(),
      servers: () => [{ name: 'cedar', host: '192.0.2.13', status: 'online', lastSeenAt: T0, claudeVersion: '2.1.295', kitVersion: '1', sysinfo: null }],
    },
  };
  const reply = async (text: string): Promise<void> => {
    replies.push(text);
  };
  return { deps, outbound, replies, reply, update, callOwner, release, sentElsewhere };
}

describe('runCommand', () => {
  it('/login codex starts the ChatGPT sign-in as an audited action (its message is sent by the action)', async () => {
    const t = setup();
    vi.mocked(t.deps.actions.request).mockResolvedValue(signInAction('done'));
    await runCommand({ name: 'login', arg: 'Codex' }, t.deps, t.reply);
    expect(t.deps.actions.request).toHaveBeenCalledWith({ kind: 'account.login', actor: 'owner', channel: 'test-channel', params: { target: 'codex' } });
    expect(t.replies).toEqual([]);
  });

  it('/login ash starts the sign-in as an audited action; the link comes from the action, never from the audit row', async () => {
    const t = setup();
    t.deps.login = { submit: vi.fn(), waiting: () => false };
    vi.mocked(t.deps.actions.request).mockResolvedValue(signInAction('done'));
    await runCommand({ name: 'login', arg: 'ash' }, t.deps, t.reply);
    expect(t.deps.actions.request).toHaveBeenCalledWith({ kind: 'account.login', actor: 'owner', channel: 'test-channel', params: { target: 'ash' } });
    expect(t.replies).toEqual(['⏳ Starting the sign-in for ash…']);
  });

  it('/login on a signed-in host with PIN confirmations on asks for the PIN in a message the owner replies to', async () => {
    const t = setup();
    t.deps.login = { submit: vi.fn(), waiting: () => false };
    vi.mocked(t.deps.actions.request).mockResolvedValue(signInAction('pending_confirmation'));
    await runCommand({ name: 'login', arg: null }, t.deps, t.reply);
    expect(t.outbound.sent).toEqual([{
      text: '🔐 Luady is signed in: a new sign-in can move it to another account. Reply to this message with your PIN to go on, or *no* to cancel. (#A9)',
      link: { kind: 'action', refId: 'A9' }, quotedId: null,
    }]);
  });

  it('/login answers the failure when the sign-in did not start', async () => {
    const t = setup();
    t.deps.login = { submit: vi.fn(), waiting: () => false };
    vi.mocked(t.deps.actions.request).mockResolvedValue({ ...signInAction('failed'), error: 'The server returned an unexpected sign-in link' });
    await runCommand({ name: 'login', arg: 'cedar' }, t.deps, t.reply);
    expect(t.replies.at(-1)).toBe('❌ Sign-in failed: The server returned an unexpected sign-in link\nSend /login cedar to try again.');
  });

  it('/status replies with the fleet summary', async () => {
    const t = setup({ pending: [pendingQuestion('ABCDEFGH', 'question')] });
    await runCommand({ name: 'status' }, t.deps, t.reply);
    expect(t.replies).toHaveLength(1);
    expect(t.replies[0]).toContain('📊 *Status*');
    expect(t.replies[0]).toContain('Servers: cedar 🟢');
    expect(t.replies[0]).toContain('Questions: 1 · Confirmations: 0');
    expect(t.replies[0]).toContain('Luady: running · Away: off');
  });

  it('/q re-sends every pending question with a fresh question link', async () => {
    const t = setup({ pending: [pendingQuestion('ABCDEFGH', 'question'), pendingQuestion('QRSTUVWX', 'permission')] });
    await runCommand({ name: 'q' }, t.deps, t.reply);
    expect(t.outbound.sent.map((s) => s.link)).toEqual([
      { kind: 'question', refId: 'ABCDEFGH' }, { kind: 'question', refId: 'QRSTUVWX' },
    ]);
    expect(t.outbound.sent[1]?.text).toContain('Wants to use *Bash*:');
    expect(t.replies).toEqual([]);
    expect(t.sentElsewhere.mock.calls).toEqual([['question', 'ABCDEFGH', 'fake-wa-1'], ['question', 'QRSTUVWX', 'fake-wa-2']]);
    const none = setup();
    await runCommand({ name: 'q' }, none.deps, none.reply);
    expect(none.replies).toEqual(['ℹ️ No pending questions.']);
  });

  it('/away and /back toggle away mode', async () => {
    const t = setup();
    await runCommand({ name: 'away' }, t.deps, t.reply);
    await runCommand({ name: 'back' }, t.deps, t.reply);
    expect(t.update).toHaveBeenNthCalledWith(1, { away: true });
    expect(t.update).toHaveBeenNthCalledWith(2, { away: false });
    expect(t.replies).toEqual(['✔ Away mode on — every finished turn will be sent.', '✔ Away mode off']);
  });

  it('/local releases the question to the terminal', async () => {
    const t = setup();
    await runCommand({ name: 'local', qid: 'ABCDEFGH' }, t.deps, t.reply);
    expect(t.release).toHaveBeenCalledWith('ABCDEFGH', 'test-channel');
    expect(t.replies).toEqual(['✔ #ABCDEFGH released to the terminal']);
  });

  it('/local reports a missing qid, an already-resolved question and an unknown one', async () => {
    const usage = setup();
    await runCommand({ name: 'local', qid: null }, usage.deps, usage.reply);
    const closed = setup({ release: async () => { throw new QuestionClosedError('timeout', 'Question is closed'); } });
    await runCommand({ name: 'local', qid: 'ABCDEFGH' }, closed.deps, closed.reply);
    const missing = setup({ release: async () => { throw new NotFoundError('Question ABCDEFGH not found'); } });
    await runCommand({ name: 'local', qid: 'ABCDEFGH' }, missing.deps, missing.reply);
    expect(usage.replies).toEqual([LOCAL_USAGE]);
    expect(closed.replies).toEqual(['ℹ️ #ABCDEFGH was already timeout — your reply was not sent.']);
    expect(missing.replies).toEqual(['ℹ️ Question ABCDEFGH not found']);
  });

  it('/help lists the commands', async () => {
    const t = setup();
    await runCommand({ name: 'help' }, t.deps, t.reply);
    expect(t.replies).toEqual([helpText()]);
  });
});

describe('noticeForError', () => {
  it('maps every hub error to its notice', () => {
    const log = silentLogger();
    expect(noticeForError(new QuestionClosedError('answered', 'closed'), { log, qid: 'ABCDEFGH' })).toBe(
      'ℹ️ #ABCDEFGH was already answered — your reply was not sent.',
    );
    expect(noticeForError(new QuestionPendingError('ABCDEFGH', 'pending'), { log, label: 'cedar · meadow-hr' })).toBe(
      'ℹ️ cedar · meadow-hr is waiting for an answer to #ABCDEFGH — reply to that question first.',
    );
    expect(noticeForError(new PinInvalidError(2), { log })).toBe('⛔ Wrong PIN (2 tries left)');
    expect(noticeForError(new PinLockedError('2026-10-09T15:42:00.000Z'), { log })).toBe('🔒 PIN locked until 7:42 PM');
    expect(noticeForError(new PinNotSetError(), { log })).toBe(PIN_NOT_SET_NOTICE);
    expect(noticeForError(new RefusedError('Pane is not running claude'), { log })).toBe('⚠️ Pane is not running claude');
    expect(noticeForError(new Error('secret internals'), { log })).toBe(GENERIC_ERROR_NOTICE);
  });
  it('/missions lists open missions, /sessions groups sessions per server', async () => {
    const t = setup({ missions: ['📌 *birch · orchard* — ⏳ Working'] });
    await runCommand({ name: 'missions' }, t.deps, t.reply);
    const none = setup();
    await runCommand({ name: 'missions' }, none.deps, none.reply);
    await runCommand({ name: 'sessions' }, none.deps, none.reply);
    expect(t.replies).toEqual(['📌 *birch · orchard* — ⏳ Working']);
    expect(none.replies).toEqual(['No open missions.', 'No sessions are running on your servers.']);
  });

  it('/mute sets and clears mute_until, with usage for bad input', async () => {
    const t = setup();
    await runCommand({ name: 'mute', arg: '2' }, t.deps, t.reply);
    expect(t.update.mock.calls[0]?.[0].mute_until).toMatch(/^\d{4}-\d\d-\d\dT/);
    await runCommand({ name: 'mute', arg: 'off' }, t.deps, t.reply);
    expect(t.update).toHaveBeenLastCalledWith({ mute_until: null });
    await runCommand({ name: 'mute', arg: 'soon' }, t.deps, t.reply);
    expect(t.replies[0]).toContain('🔕 Muted until');
    expect(t.replies[1]).toBe('🔔 Notifications are back on.');
    expect(t.replies[2]).toContain('Usage: /mute');
  });

  it('/new and /today go to Luady; /new without a valid server shows usage; /reset restarts Luady', async () => {
    const t = setup();
    const rotate = vi.fn(async () => true);
    t.deps.luady.rotate = rotate;
    await runCommand({ name: 'new', server: 'birch', project: 'orchard', task: 'fix login' }, t.deps, t.reply);
    await runCommand({ name: 'today' }, t.deps, t.reply);
    await runCommand({ name: 'new', server: 'xx', project: 'p', task: 't' }, t.deps, t.reply);
    await runCommand({ name: 'reset' }, t.deps, t.reply);
    const posted = vi.mocked(t.deps.luady.postOwnerMessage).mock.calls.map((call) => call[0]);
    expect(posted[0]).toContain('/new mission on birch, project "orchard": fix login');
    expect(posted[1]).toContain('/today');
    // Built from the fleet's own hosts, never fixed names.
    expect(posted[1]).toContain('across cedar, birch, ash and local in a few');
    expect(rotate).toHaveBeenCalledWith(true);
    expect(t.replies).toEqual([
      'Usage: /new <server> <project> <task>\ne.g. /new cedar web-app fix the login loop',
      '♻️ Luady restarted with a fresh conversation (memory files kept).',
    ]);
  });

});

function signInAction(status: 'done' | 'pending_confirmation' | 'failed') {
  return {
    id: 'A9', actor: 'owner' as const, channel: 'test-channel' as const, kind: 'account.login', tier: 1 as const, summary: 'start a Claude sign-in',
    status, createdAt: T0, decidedAt: null, result: status === 'done' ? 'sign-in started' : null, error: null,
  };
}

describe('/todo <text>', () => {
  it('adds a card from the chat and answers with its number, without Luady', async () => {
    const t = setup();
    const add = vi.fn(async () => ({ id: 12, title: 'buy milk' }));
    const deps = { ...t.deps, board: { add } } as unknown as CommandDeps;
    await runCommand({ name: 'todo_add', text: 'buy milk' }, deps, t.reply);
    expect(add).toHaveBeenCalledWith({ title: 'buy milk', source: 'chat' }, 'owner');
    expect(t.replies).toEqual(['Added #12: buy milk']);
    expect(t.deps.luady.postOwnerMessage).not.toHaveBeenCalled();
  });

  it('refuses a PIN-like text and says when the board is not there', async () => {
    const t = setup();
    const add = vi.fn();
    await runCommand({ name: 'todo_add', text: '123456' }, { ...t.deps, board: { add } } as unknown as CommandDeps, t.reply);
    await runCommand({ name: 'todo_add', text: 'x' }, t.deps, t.reply);
    expect(add).not.toHaveBeenCalled();
    expect(t.replies[1]).toBe('The board is not available.');
    expect(t.replies[0]).not.toContain('123456');
  });
});
