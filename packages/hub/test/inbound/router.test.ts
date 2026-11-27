import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type ActionDTO, type Channel, type QuestionDTO, type SessionDTO } from '@luady/shared';
import type { IncomingFrame } from '../../src/channels/host.js';
import { createLinkStore } from '../../src/channels/link-store.js';
import { ManagerOffError } from '../../src/luady/errors.js';
import {
  PinInvalidError, PinLockedError, QuestionClosedError,
} from '../../src/core/errors.js';
import type { ActionRequest } from '../../src/core/contracts.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createInboundRouter, type RouterDeps } from '../../src/inbound/router.js';
import { GENERIC_ERROR_NOTICE, MANAGER_OFF_NOTICE, PIN_LIKE_NOTICE, TEXT_ONLY_NOTICE, helpText } from '../../src/notify/format.js';
import { createFakeClock, createFakeOutbound, silentLogger, classicHostLookups } from '../../test/helpers/fakes.js';
import { HELD_FIRST, HELD_MORE } from '../../src/claude-login/text.js';
import type { ChatLogin } from '../../src/claude-login/chat-login.js';

const T0 = '2026-10-09T12:00:00.000Z';
/** The chat channel these messages come from (an add-on id). */
const CH = 'test-channel';
const SESSION: SessionDTO = {
  id: 'cedar:cc-meadow-hr:0.0', host: 'cedar', target: 'cc-meadow-hr:0.0', claudeSessionId: 'c-1',
  cwd: '/home/dev/projects/meadow-hr', project: 'meadow-hr', displayName: 'meadow-hr', state: 'idle',
  origin: 'owner', registered: true, lastEventAt: null, turnStartedAt: null, pendingQid: null, unexpectedEnd: false,
};

function question(qid: string, state: QuestionDTO['state'] = 'pending', kind: QuestionDTO['kind'] = 'question'): QuestionDTO {
  return {
    qid, kind, host: 'cedar', sessionId: SESSION.id, sessionLabel: 'meadow-hr',
    questions: kind === 'question' ? [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] : [],
    permission: kind === 'permission' ? { toolName: 'Bash', inputPreview: 'rm -rf build' } : null,
    state, createdAt: T0, resolvedAt: null, resolvedVia: null,
  };
}

function action(id: string, status: ActionDTO['status'], result: string | null): ActionDTO {
  return {
    id, actor: 'manager', channel: 'event', kind: 'session.stop', tier: 1, summary: 'stop cedar · meadow-hr', status,
    createdAt: T0, decidedAt: T0, result, error: null,
  };
}

interface Quoted { quotedText?: string; quotedFromMe?: boolean; quotedMedia?: NonNullable<IncomingFrame['replyTo']>['media'] }

function incoming(msgId: string, text: string, quotedId: string | null = null, quoted: Quoted = {}): IncomingFrame {
  const replyTo = quotedId === null ? undefined : {
    msgId: quotedId,
    ...(quoted.quotedText === undefined ? {} : { text: quoted.quotedText }),
    ...(quoted.quotedFromMe === undefined ? {} : { fromMe: quoted.quotedFromMe }),
    ...(quoted.quotedMedia === undefined ? {} : { media: quoted.quotedMedia }),
  };
  return { t: 'incoming', msgId, from: '447700900001', text, ts: 1_791_547_200, ...(replyTo === undefined ? {} : { replyTo }) };
}

function setup(questions: QuestionDTO[] = [], login?: ChatLogin, luadyOut = false, managerOff = false) {
  const db = openMemoryDb();
  const base = mkdtempSync(join(tmpdir(), 'luady-inbound-'));
  const files = join(base, 'addons', CH, 'files');
  const inboxDir = join(base, 'brain', 'inbox');
  mkdirSync(files, { recursive: true });
  const outbound = createFakeOutbound();
  const store = new Map(questions.map((q) => [q.qid, q] as const));
  const close = (qid: string): QuestionDTO => {
    const current = store.get(qid);
    if (!current || current.state !== 'pending') throw new QuestionClosedError(current?.state ?? 'answered', 'closed');
    const next: QuestionDTO = { ...current, state: 'answered' };
    store.set(qid, next);
    return next;
  };
  const answer = vi.fn(async (qid: string, _answers: Record<string, string>, _via: Channel) => close(qid));
  const answerPermission = vi.fn(
    async (qid: string, _behavior: 'allow' | 'deny', _message: string | undefined, _via: Channel) => close(qid),
  );
  const send = vi.fn(async (_id: string, _text: string, _channel: Channel): Promise<void> => undefined);
  const request = vi.fn(async (_req: ActionRequest) => action('A9', 'done', 'sign-in started'));
  const confirm = vi.fn(async (id: string, _pin: string, _via: Channel) => action(id, 'done', 'stopped'));
  const deny = vi.fn(async (id: string, _via: Channel) => action(id, 'denied', null));
  let held = 0;
  const postOwnerMessage = vi.fn(async (_text: string, _channel: Channel): Promise<void> => {
    if (managerOff) throw new ManagerOffError();
    if (luadyOut) held += 1;
  });
  const deps: RouterDeps = {
    clock: createFakeClock(T0), log: silentLogger(), outbound, links: createLinkStore(db), media: { root: () => files, inboxDir },
    questions: {
      pending: () => [...store.values()].filter((q) => q.state === 'pending'), get: (qid) => store.get(qid),
      answer, answerPermission, release: vi.fn(), markNotified: vi.fn(), markEscalated: vi.fn(),
    },
    sessions: {
      list: () => [SESSION], get: (id) => (id === SESSION.id ? SESSION : undefined), findByRef: () => undefined, send,
      interrupt: vi.fn(), start: vi.fn(), stop: vi.fn(), restart: vi.fn(), remove: vi.fn(), transcript: vi.fn(),
      condensed: vi.fn(),
    },
    actions: { request, confirm, deny, get: vi.fn(), list: vi.fn(), pending: () => [], sweepExpired: vi.fn() },
    luady: {
      status: () => ({ state: 'running', since: T0, claudeSessionId: null, queued: held }), start: vi.fn(), stop: vi.fn(),
      postOwnerMessage, postEvent: vi.fn(), messages: vi.fn(), signedOut: () => luadyOut,
    },
    settings: { get: () => DEFAULT_SETTINGS, update: vi.fn() },
    phone: { enabled: () => false, callForQuestion: vi.fn(), callOwner: vi.fn() },
    fleet: { start: vi.fn(), stop: vi.fn(), client: vi.fn(), servers: () => [], openShell: vi.fn(), ...classicHostLookups(), tailEvents: vi.fn() },
    ...(login ? { login } : {}),
  };
  const link = (chatMsgId: string, kind: string, refId: string): void => {
    db.prepare('INSERT INTO channel_links (channel, msg_id, kind, ref_id, created_at) VALUES (?, ?, ?, ?, ?)').run(CH, chatMsgId, kind, refId, T0);
  };
  const texts = (): string[] => outbound.sent.map((s) => s.text);
  const router = createInboundRouter(deps);
  /** A file the add-on saved in its own files folder. */
  const saved = (name: string, body = 'x'.repeat(1000)): string => {
    const path = join(files, name);
    writeFileSync(path, body);
    return path;
  };
  return { router: { handle: (frame: IncomingFrame) => router.handle(CH, frame) }, saved, base, inboxDir, outbound, answer, answerPermission, send, request, confirm, deny, postOwnerMessage, link, texts };
}

describe('createInboundRouter', () => {
  it('answers a quoted question with the mapped option and acknowledges in a quote', async () => {
    const t = setup([question('ABCDEFGH')]);
    t.link('wamid.Q1', 'question', 'ABCDEFGH');
    await t.router.handle(incoming('in-1', '2', 'wamid.Q1'));
    expect(t.answer).toHaveBeenCalledWith('ABCDEFGH', { 'Which DB?': 'SQLite' }, CH);
    expect(t.texts()).toEqual(['✔ Answer delivered to cedar · meadow-hr']);
    expect(t.outbound.sent[0]?.quotedId).toBe('in-1');
  });

  it('quoted reply to resolved question is rejected', async () => {
    for (const state of ['answered', 'released', 'timeout'] as const) {
      const t = setup([question('ABCDEFGH', state)]);
      t.link('wamid.Q1', 'question', 'ABCDEFGH');
      await t.router.handle(incoming(`in-${state}`, 'Use Postgres please', 'wamid.Q1'));
      expect(t.texts()).toEqual([`ℹ️ #ABCDEFGH was already ${state} — your reply was not sent.`]);
      expect(t.answer).not.toHaveBeenCalled();
      expect(t.send).not.toHaveBeenCalled();
      expect(t.postOwnerMessage).not.toHaveBeenCalled();
    }
  });

  it('duplicate msgId ignored', async () => {
    const t = setup([question('ABCDEFGH')]);
    t.link('wamid.Q1', 'question', 'ABCDEFGH');
    await t.router.handle(incoming('in-1', '1', 'wamid.Q1'));
    await t.router.handle(incoming('in-1', '1', 'wamid.Q1'));
    expect(t.answer).toHaveBeenCalledTimes(1);
    expect(t.texts()).toEqual(['✔ Answer delivered to cedar · meadow-hr']);
  });

  it('second answer gets already-answered notice', async () => {
    const t = setup([question('ABCDEFGH')]);
    t.link('wamid.Q1', 'question', 'ABCDEFGH');
    await t.router.handle(incoming('in-1', '1', 'wamid.Q1'));
    await t.router.handle(incoming('in-2', '2', 'wamid.Q1'));
    expect(t.answer).toHaveBeenCalledTimes(1);
    expect(t.texts()).toEqual([
      '✔ Answer delivered to cedar · meadow-hr', 'ℹ️ #ABCDEFGH was already answered — your reply was not sent.',
    ]);
  });

  it('gives the already notice when the question closes while answering', async () => {
    const t = setup([question('ABCDEFGH')]);
    t.link('wamid.Q1', 'question', 'ABCDEFGH');
    t.answer.mockRejectedValueOnce(new QuestionClosedError('timeout', 'closed'));
    await t.router.handle(incoming('in-1', '1', 'wamid.Q1'));
    expect(t.texts()).toEqual(['ℹ️ #ABCDEFGH was already timeout — your reply was not sent.']);
    expect(t.send).not.toHaveBeenCalled();
  });

  it('answers a quoted permission with yes, or denies with the text as the message', async () => {
    const yes = setup([question('QRSTUVWX', 'pending', 'permission')]);
    yes.link('wamid.P1', 'question', 'QRSTUVWX');
    await yes.router.handle(incoming('in-1', 'نعم', 'wamid.P1'));
    expect(yes.answerPermission).toHaveBeenCalledWith('QRSTUVWX', 'allow', undefined, CH);
    const other = setup([question('QRSTUVWX', 'pending', 'permission')]);
    other.link('wamid.P1', 'question', 'QRSTUVWX');
    await other.router.handle(incoming('in-2', 'not now, run the tests', 'wamid.P1'));
    expect(other.answerPermission).toHaveBeenCalledWith('QRSTUVWX', 'deny', 'not now, run the tests', CH);
  });

  it('replies with help for out-of-range options without answering', async () => {
    const t = setup([question('ABCDEFGH')]);
    t.link('wamid.Q1', 'question', 'ABCDEFGH');
    await t.router.handle(incoming('in-1', '9', 'wamid.Q1'));
    expect(t.answer).not.toHaveBeenCalled();
    expect(t.texts()).toEqual(['ℹ️ #ABCDEFGH: reply with a number from 1 to 2 (1,3 for several), or with your own answer.']);
  });

  it('hands a reply to a mission or session message to Luady with its context, never straight to the session', async () => {
    const t = setup();
    t.link('wamid.S1', 'session', SESSION.id);
    await t.router.handle(incoming('in-1', 'now run the tests', 'wamid.S1'));
    expect(t.send).not.toHaveBeenCalled();
    expect(t.postOwnerMessage.mock.calls.map((c) => c[0])).toEqual([
      `now run the tests\n(Reply to your message about cedar · meadow-hr (${SESSION.id}))`,
    ]);
    expect(t.texts()).toEqual([]);
  });

  it("a reply to a brain-failure alert (linked to the brain's session) goes to Luady through the PIN guard", async () => {
    const t = setup();
    t.link('wamid.B1', 'session', 'hq:manager:0.0');
    await t.router.handle(incoming('in-1', 'try again', 'wamid.B1'));
    await t.router.handle(incoming('in-2', '482916', 'wamid.B1'));
    expect(t.send).not.toHaveBeenCalled();
    expect(t.postOwnerMessage.mock.calls.map((c) => c[0])).toEqual(['try again\n(Reply to your message about hq:manager:0.0 (hq:manager:0.0))']);
    expect(t.texts()).toEqual([PIN_LIKE_NOTICE]);
  });

  it('approves a confirmation with the PIN, cancels with no, and explains anything else', async () => {
    const t = setup();
    t.link('wamid.A1', 'action', 'A7');
    await t.router.handle(incoming('in-1', '123456', 'wamid.A1'));
    await t.router.handle(incoming('in-2', 'no', 'wamid.A1'));
    await t.router.handle(incoming('in-3', 'maybe later', 'wamid.A1'));
    expect(t.confirm).toHaveBeenCalledWith('A7', '123456', CH);
    expect(t.deny).toHaveBeenCalledWith('A7', CH);
    expect(t.texts()).toEqual([
      '✔ Approved #A7: stopped', '✖ Cancelled #A7', 'ℹ️ Reply with your PIN to approve #A7, or *no* to cancel.',
    ]);
  });

  it('reports a wrong or locked PIN', async () => {
    const t = setup();
    t.link('wamid.A1', 'action', 'A7');
    t.confirm.mockRejectedValueOnce(new PinInvalidError(2));
    t.confirm.mockRejectedValueOnce(new PinLockedError('2026-10-09T15:42:00.000Z'));
    await t.router.handle(incoming('in-1', '111111', 'wamid.A1'));
    await t.router.handle(incoming('in-2', '222222', 'wamid.A1'));
    expect(t.texts()).toEqual(['⛔ Wrong PIN (2 tries left)', '🔒 PIN locked until 7:42 PM']);
  });

  it('runs commands before anything else', async () => {
    const t = setup();
    await t.router.handle(incoming('in-1', '/HELP'));
    expect(t.texts()).toEqual([helpText()]);
    expect(t.postOwnerMessage).not.toHaveBeenCalled();
  });

  it('answers the single pending question with a bare number', async () => {
    const t = setup([question('ABCDEFGH')]);
    await t.router.handle(incoming('in-1', '1'));
    expect(t.answer).toHaveBeenCalledWith('ABCDEFGH', { 'Which DB?': 'Postgres' }, CH);
    expect(t.postOwnerMessage).not.toHaveBeenCalled();
  });

  it('sends everything else to Luady, including replies quoting a Luady message', async () => {
    const t = setup([question('ABCDEFGH'), question('QRSTUVWX')]);
    t.link('wamid.L1', 'manager', 'm-1');
    await t.router.handle(incoming('in-1', 'what is birch doing?'));
    await t.router.handle(incoming('in-2', '2'));
    await t.router.handle(incoming('in-3', 'and ash?', 'wamid.L1'));
    await t.router.handle(incoming('in-4', 'hello', 'wamid.unknown'));
    expect(t.postOwnerMessage.mock.calls.map((c) => c[0])).toEqual([
      'what is birch doing?', '2', 'and ash?\n(Reply to your message)', 'hello\n(Reply to an earlier message)',
    ]);
    expect(t.answer).not.toHaveBeenCalled();
  });

  it('quotes the message the owner replied to, saying whose it was', async () => {
    const t = setup();
    t.link('wamid.L1', 'manager', 'msg-1');
    await t.router.handle(incoming('in-1', 'stop the second one', 'wamid.L1', { quotedText: '📌 Mission · cedar · meadow-vat' }));
    await t.router.handle(incoming('in-2', 'do it', 'wamid.old', { quotedText: '📧 Sara wants the contract by Monday', quotedFromMe: true }));
    await t.router.handle(incoming('in-3', 'this one', 'wamid.mine', { quotedText: 'fix the login page', quotedFromMe: false }));
    expect(t.postOwnerMessage.mock.calls.map((c) => c[0])).toEqual([
      'stop the second one\n(Reply to your message: "📌 Mission · cedar · meadow-vat")',
      'do it\n(Reply to your message: "📧 Sara wants the contract by Monday")',
      'this one\n(Reply to their own message: "fix the login page")',
    ]);
  });

  it('bare PIN-shaped text is never forwarded to Luady', async () => {
    const t = setup();
    t.link('wamid.L1', 'manager', 'm-1');
    await t.router.handle(incoming('in-1', '482913'));
    await t.router.handle(incoming('in-2', ' 000482913 ', 'wamid.L1'));
    await t.router.handle(incoming('in-3', '٤٨٢٩١٣'));
    expect(t.postOwnerMessage).not.toHaveBeenCalled();
    expect(t.texts()).toEqual([PIN_LIKE_NOTICE, PIN_LIKE_NOTICE, PIN_LIKE_NOTICE]);
  });

  it('PIN-shaped text is never delivered as an answer, a caption or a voice note; only a confirmation reply takes it', async () => {
    const open = { ...question('NOOPTION'), questions: [{ question: 'Enter the code to continue', options: [] }] };
    const two = { ...question('TWOQUEST'), questions: [{ question: 'Which DB?', options: [{ label: 'Postgres' }] }, { question: 'Code?', options: [] }] };
    const t = setup([open, question('PERMISSN', 'pending', 'permission'), two]);
    t.link('wamid.Q1', 'question', 'NOOPTION');
    t.link('wamid.P1', 'question', 'PERMISSN');
    t.link('wamid.Q2', 'question', 'TWOQUEST');
    t.link('wamid.A1', 'action', 'A7');
    await t.router.handle(incoming('in-1', '482913', 'wamid.Q1'));
    await t.router.handle(incoming('in-2', '482913', 'wamid.P1'));
    await t.router.handle(incoming('in-3', '1\n482913', 'wamid.Q2'));
    const image = { kind: 'image' as const, path: t.saved('p.jpg'), mime: 'image/jpeg', fileName: 'p.jpg', size: 1000, error: null };
    await t.router.handle({ ...incoming('in-4', '482913'), media: image });
    const voice = { ...image, kind: 'audio' as const, path: t.saved('v.ogg'), fileName: 'v.ogg', voice: { transcript: '4 8 2 9 1 3', error: null } };
    await t.router.handle({ ...incoming('in-5', ''), media: voice });
    await t.router.handle({ ...incoming('in-6', '482913', 'wamid.A1'), media: image });
    expect(t.answer).not.toHaveBeenCalled();
    expect(t.answerPermission).not.toHaveBeenCalled();
    expect(t.postOwnerMessage).not.toHaveBeenCalled();
    expect(t.confirm).not.toHaveBeenCalled();
    expect(t.texts()).toEqual(Array.from({ length: 6 }, () => PIN_LIKE_NOTICE));
    await t.router.handle(incoming('in-7', '482913', 'wamid.A1'));
    expect(t.confirm).toHaveBeenCalledWith('A7', '482913', CH);
  });

  it('a yes to a permission the chat had to cut allows nothing, whatever its kind: it says to answer on the website or in the terminal', async () => {
    const long = { ...question('LONGCMND', 'pending', 'permission'), permission: { toolName: 'Bash', inputPreview: `echo ${'x'.repeat(700)}` } };
    const mcp = { ...question('LONGMCPX', 'pending', 'permission'), permission: { toolName: 'mcp__shell__run', inputPreview: 'y'.repeat(700) } };
    const write = {
      ...question('LONGWRIT', 'pending', 'permission'),
      permission: {
        toolName: 'Write', inputPreview: '{}',
        preview: {
          tool: 'Write', kind: 'write' as const, command: null, path: '/home/dev/.bashrc', cwd: null, truncated: false, always: null, allow: true,
          edits: [{ old: '', new: Array.from({ length: 70 }, (_, i) => `echo line ${i}`).join('\n') }],
        },
      },
    };
    const t = setup([long, mcp, write]);
    t.link('wamid.P9', 'question', 'LONGCMND');
    t.link('wamid.P8', 'question', 'LONGMCPX');
    t.link('wamid.P7', 'question', 'LONGWRIT');
    await t.router.handle(incoming('in-1', 'yes', 'wamid.P9'));
    await t.router.handle(incoming('in-3', 'yes', 'wamid.P8'));
    await t.router.handle(incoming('in-4', 'yes', 'wamid.P7'));
    expect(t.answerPermission).not.toHaveBeenCalled();
    expect(t.texts()).toEqual(Array.from({ length: 3 }, () => 'ℹ️ This request is too long to show here in full. Answer it on the website or in the terminal, where you can see all of it.'));
    await t.router.handle(incoming('in-2', 'no', 'wamid.P9'));
    expect(t.answerPermission).toHaveBeenCalledWith('LONGCMND', 'deny', undefined, CH);
  });

  it('the refusal of a PIN-shaped text says how to send a real number, and a word in front of it gets it through', async () => {
    const open = { ...question('NOOPTION'), questions: [{ question: 'Enter the code to continue', options: [] }] };
    const t = setup([open]);
    t.link('wamid.Q1', 'question', 'NOOPTION');
    expect(PIN_LIKE_NOTICE).toContain('put a word in front of it');
    await t.router.handle(incoming('in-1', 'code 482913', 'wamid.Q1'));
    expect(t.answer).toHaveBeenCalledWith('NOOPTION', { 'Enter the code to continue': 'code 482913' }, CH);
  });

  it('a bare PIN is never taken as the answer to the only pending question, even one without options', async () => {
    const open = { ...question('NOOPTION'), questions: [{ question: 'Type the code shown on your screen', options: [] }] };
    const t = setup([open]);
    await t.router.handle(incoming('in-1', '482913'));
    expect(t.answer).not.toHaveBeenCalled();
    expect(t.postOwnerMessage).not.toHaveBeenCalled();
    expect(t.texts()).toEqual([PIN_LIKE_NOTICE]);
  });

  it('normalizes Arabic-Indic digits for options and PINs', async () => {
    const t = setup([question('ABCDEFGH')]);
    t.link('wamid.Q1', 'question', 'ABCDEFGH');
    t.link('wamid.A1', 'action', 'A7');
    await t.router.handle(incoming('in-1', '٢', 'wamid.Q1'));
    await t.router.handle(incoming('in-2', '١٢٣٤٥٦', 'wamid.A1'));
    expect(t.answer).toHaveBeenCalledWith('ABCDEFGH', { 'Which DB?': 'SQLite' }, CH);
    expect(t.confirm).toHaveBeenCalledWith('A7', '123456', CH);
  });

  it('answers an empty or media-only message with the text-only notice', async () => {
    const t = setup();
    await t.router.handle(incoming('in-1', '   '));
    expect(t.texts()).toEqual([TEXT_ONLY_NOTICE]);
    expect(t.postOwnerMessage).not.toHaveBeenCalled();
  });

  it('never lets a failure escape handle', async () => {
    const t = setup();
    t.postOwnerMessage.mockRejectedValueOnce(new Error('tmux exploded'));
    await expect(t.router.handle(incoming('in-1', 'hello'))).resolves.toBeUndefined();
    expect(t.texts()).toEqual([GENERIC_ERROR_NOTICE]);
  });

  it('forwards a file the owner sent to the manager, copied into the inbox, even as a reply or without a caption', async () => {
    const t = setup();
    const media = { kind: 'image' as const, path: t.saved('photo.jpg'), mime: 'image/jpeg', fileName: 'photo.jpg', size: 204800, error: null };
    await t.router.handle({ ...incoming('IMG1', 'send this to ash'), media });
    await t.router.handle({ ...incoming('DOC1', ''), media: { ...media, kind: 'document', fileName: 'Q3.xlsx', mime: 'application/x', path: null, error: 'download timed out' } });
    expect(t.postOwnerMessage.mock.calls.map((c) => c[0])).toEqual([
      `send this to ash\n[Attached image "photo.jpg" (image/jpeg, 200 KB): ${join(t.inboxDir, '20261009-120000-IMG1-photo.jpg')}]`,
      '[The owner sent a document "Q3.xlsx" (application/x, 200 KB) but it could not be saved: download timed out]',
    ]);
    expect(t.texts()).toEqual([]);
  });

  it("refuses a file path outside the add-on's own files folder: the manager never sees that path", async () => {
    const t = setup();
    const outside = join(t.base, 'secrets.env');
    writeFileSync(outside, 'SESSION_SECRET=x');
    const media = { kind: 'document' as const, path: outside, mime: 'text/plain', fileName: 'secrets.env', size: 16, error: null };
    await t.router.handle({ ...incoming('OUT1', ''), media });
    await t.router.handle({ ...incoming('OUT2', ''), media: { ...media, path: join(t.base, 'addons', CH, 'files', '..', '..', '..', 'secrets.env') } });
    const refused = '[The owner sent a document "secrets.env" (text/plain, 1 KB) but it could not be saved: the file was refused (outside)]';
    expect(t.postOwnerMessage.mock.calls.map((c) => c[0])).toEqual([refused, refused]);
  });

  it('a voice note the add-on transcribed gives the manager the words plus the file, and marks it played', async () => {
    const t = setup();
    const media = {
      kind: 'audio' as const, path: t.saved('v.ogg', 'x'.repeat(9000)), mime: 'audio/ogg', fileName: 'audio.ogg', size: 9000, error: null,
      voice: { transcript: 'شغّل الاختبارات على ash', error: null },
    };
    t.link('NOTIF-Q', 'question', 'Q7');
    await t.router.handle({ ...incoming('VOICE1', '', 'NOTIF-Q'), media });
    expect(t.outbound.played).toEqual(['VOICE1']);
    expect(t.postOwnerMessage.mock.calls.map((c) => c[0])).toEqual([
      `🎤 Voice note (transcribed): شغّل الاختبارات على ash\n[Attached audio "audio.ogg" (audio/ogg, 9 KB): ${join(t.inboxDir, '20261009-120000-VOICE1-audio.ogg')}]\n(Reply to your message)`,
    ]);
  });

  it('still hands the manager the voice note file when the add-on could not transcribe it', async () => {
    const t = setup();
    const media = {
      kind: 'audio' as const, path: t.saved('v.ogg', 'x'.repeat(9000)), mime: 'audio/ogg', fileName: 'audio.ogg', size: 9000, error: null,
      voice: { transcript: null, error: 'the transcription service is not running' },
    };
    await t.router.handle({ ...incoming('VOICE2', ''), media });
    expect(t.outbound.played).toEqual([]);
    expect(t.postOwnerMessage.mock.calls[0]?.[0]).toBe(
      `[Attached audio "audio.ogg" (audio/ogg, 9 KB): ${join(t.inboxDir, '20261009-120000-VOICE2-audio.ogg')}]\n(Transcription failed: the transcription service is not running)`,
    );
  });

  it('adds the replied-to picture line (or a resend note) before the reply note', async () => {
    const t = setup();
    const picture = { kind: 'image' as const, path: t.saved('quoted.jpg', 'x'.repeat(51200)), mime: 'image/jpeg', fileName: 'image.jpg', size: 51200, error: null };
    await t.router.handle(incoming('R1', 'make the sky purple', 'QIMG1', { quotedText: '[image]', quotedFromMe: false, quotedMedia: picture }));
    const photo = { ...picture, path: t.saved('p.jpg', 'x'.repeat(51200)) };
    await t.router.handle({ ...incoming('R2', 'like this', 'QIMG2', { quotedFromMe: true, quotedMedia: { ...picture, path: null, error: 'expired' } }), media: photo });
    expect(t.postOwnerMessage.mock.calls.map((c) => c[0])).toEqual([
      `make the sky purple\n[Replied-to image "image.jpg" (image/jpeg, 50 KB): ${join(t.inboxDir, '20261009-120000-qQIMG1-image.jpg')}]\n(Reply to their own message: "[image]")`,
      `like this\n[Attached image "image.jpg" (image/jpeg, 50 KB): ${join(t.inboxDir, '20261009-120000-R2-image.jpg')}]\n(the replied-to picture could not be downloaded — ask the owner to resend it)\n(Reply to your message)`,
    ]);
  });

  it('with the manager off, a chat message gets a plain answer and is not kept; commands still work', async () => {
    const t = setup([], undefined, false, true);
    await t.router.handle(incoming('in-1', 'what is running?'));
    expect(t.texts()).toEqual([MANAGER_OFF_NOTICE]);
    await t.router.handle(incoming('in-2', '/help'));
    expect(t.texts()[1]).toBe(helpText());
  });

  describe('/login', () => {
    const CODE = 'test-auth-code-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx#test-state-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy';
    function fakeLogin(waiting = false) {
      const login: ChatLogin = {
        begin: vi.fn(async (host) => `link for ${host}`),
        submit: vi.fn(async () => 'signed in'),
        waiting: () => waiting,
      };
      return { login };
    }

    it('/login signs Luady in; /login ash signs a server in (each an audited action); anything else gets the usage', async () => {
      const { login } = fakeLogin();
      const t = setup([], login);
      vi.mocked(t.request).mockResolvedValue(action('A9', 'done', 'sign-in started'));
      await t.router.handle(incoming('in-1', '/login'));
      await t.router.handle(incoming('in-2', '/LOGIN ash'));
      await t.router.handle(incoming('in-3', '/login mars'));
      expect(t.request.mock.calls.map((c) => c[0])).toEqual([
        { kind: 'account.login', actor: 'owner', channel: CH, params: { target: 'hq' } },
        { kind: 'account.login', actor: 'owner', channel: CH, params: { target: 'ash' } },
      ]);
      expect(t.texts()).toEqual([
        '⏳ Starting the sign-in for Luady…', '⏳ Starting the sign-in for ash…',
        'Usage: /login (signs Luady in) or /login cedar, birch, ash or local; /login codex connects ChatGPT for images',
      ]);
    });

    it('a pasted sign-in code goes to the waiting login and never to Luady, quoted or not', async () => {
      const { login } = fakeLogin();
      const t = setup([], login);
      t.link('wamid.L1', 'manager', 'x');
      await t.router.handle(incoming('in-1', `  ${CODE}
`));
      await t.router.handle(incoming('in-2', CODE, 'wamid.L1'));
      await t.router.handle(incoming('in-3', `/login ${CODE}`));
      expect(login.submit).toHaveBeenCalledTimes(3);
      expect(login.submit).toHaveBeenCalledWith(CODE, CH);
      expect(t.postOwnerMessage).not.toHaveBeenCalled();
      expect(t.texts()).toEqual(['signed in', 'signed in', 'signed in']);
    });

    it('while a sign-in waits, a code inside a sentence is taken out and sent there; the message is never stored or passed to Luady', async () => {
      const { login } = fakeLogin(true);
      const t = setup([], login);
      await t.router.handle(incoming('in-1', `here is the code: ${CODE} thanks`));
      expect(login.submit).toHaveBeenCalledWith(CODE, CH);
      expect(t.postOwnerMessage).not.toHaveBeenCalled();
      expect(t.texts()).toEqual(['signed in']);
    });

    it('with no sign-in waiting, a sentence goes to Luady as usual', async () => {
      const { login } = fakeLogin(false);
      const t = setup([], login);
      await t.router.handle(incoming('in-1', 'deploy orchard please'));
      expect(login.submit).not.toHaveBeenCalled();
      expect(t.postOwnerMessage).toHaveBeenCalledWith('deploy orchard please', CH);
    });

    it('passes messages and /today to Luady, which keeps them while it is signed out; the replies say so', async () => {
      const t = setup([], fakeLogin().login, true);
      await t.router.handle(incoming('in-1', 'what is running on birch?'));
      await t.router.handle(incoming('in-2', '/today'));
      expect(t.postOwnerMessage.mock.calls.map((c) => c[1])).toEqual([CH, CH]);
      expect(t.postOwnerMessage.mock.calls[0]?.[0]).toBe('what is running on birch?');
      expect(t.texts()).toEqual([HELD_FIRST, HELD_MORE]);
    });

    it('normal messages still reach Luady when it is signed in', async () => {
      const { login } = fakeLogin();
      const t = setup([], login);
      await t.router.handle(incoming('in-1', 'hello'));
      expect(t.postOwnerMessage).toHaveBeenCalledWith('hello', CH);
    });
  });
});
