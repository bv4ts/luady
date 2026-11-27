import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  ActionDTOSchema,
  LuadyMessageSentDTOSchema,
  ActionStatusSchema,
  AnswerBodySchema,
  ChannelSchema,
  ChatMessageDTOSchema,
  CreateSessionBodySchema,
  ExecBodySchema,
  FileWriteBodySchema,
  LuadyStatusDTOSchema,
  MeDTOSchema,
  OverviewDTOSchema,
  PasskeyRegisterOptionsBodySchema,
  PasskeyVerifyBodySchema,
  PinBodySchema,
  ProjectDTOSchema,
  QuestionDTOSchema,
  RiskDTOSchema,
  SendBodySchema,
  ServerDTOSchema,
  SessionDTOSchema,
  SessionStateSchema,
  SetPinBodySchema,
  StopBodySchema,
  TerminalOpenBodySchema,
  TranscriptItemDTOSchema,
  pageSchema,
} from '../src/api.js';
import { PREVIEW } from './helpers.js';

const NOW = '2026-10-09T12:00:00.000Z';
const SID = '0d9c3b2a-1111-4222-8333-944455556666';

const server = {
  name: 'cedar',
  host: '192.0.2.13',
  status: 'online',
  lastSeenAt: NOW,
  claudeVersion: '2.1.295',
  kitVersion: '1.0.0',
  sysinfo: { load1: 0.4, load5: 0.3, mem_total_kb: 8000000, mem_avail_kb: 4000000, disk_free_kb: 6000000, uptime_s: 3600 },
  kind: 'ssh',
  projectsRoot: null,
  homeDir: null,
  terminal: true,
};
const session = {
  id: 'cedar:cc-meadow-hr:0.0',
  host: 'cedar',
  target: 'cc-meadow-hr:0.0',
  claudeSessionId: SID,
  cwd: '/home/dev/projects/meadow-hr',
  project: 'meadow-hr',
  displayName: 'meadow-hr',
  state: 'waiting_question',
  origin: 'owner',
  registered: true,
  lastEventAt: NOW,
  turnStartedAt: '2026-10-09T11:46:00.000Z',
  pendingQid: 'ABCDEFGH',
  unexpectedEnd: false,
};
const question = {
  qid: 'ABCDEFGH',
  kind: 'question',
  host: 'cedar',
  sessionId: 'cedar:cc-meadow-hr:0.0',
  sessionLabel: 'cedar \u00b7 meadow-hr',
  questions: [{ question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
  permission: null,
  state: 'pending',
  createdAt: NOW,
  resolvedAt: null,
  resolvedVia: null,
};
const permissionQuestion = {
  ...question,
  qid: 'QRSTUVWX',
  kind: 'permission',
  questions: [],
  permission: { toolName: 'Bash', inputPreview: 'rm -rf build' },
};
const action = {
  id: 'A7',
  actor: 'manager',
  channel: 'test-channel',
  kind: 'session.stop',
  tier: 1,
  summary: 'Stop cedar \u00b7 meadow-hr',
  status: 'pending_confirmation',
  createdAt: NOW,
  decidedAt: null,
  result: null,
  error: null,
};
const chat = { id: 'f6c1b8a0-5d1e-4a51-9a63-0c8a3c7d2e11', thread: 'manager', role: 'owner', channel: 'test-channel', text: 'status?', ts: NOW };
const transcriptItem = { uuid: 'u-1', role: 'tool', text: 'Bash: npm test', ts: NOW, toolName: 'Bash' };
const luady = { state: 'running', since: NOW, claudeSessionId: null, queued: 0 };
const project = {
  server: 'cedar',
  path: '/home/dev/projects/meadow-hr',
  name: 'meadow-hr',
  remote: null,
  branch: 'main',
  commits: [],
  stack: ['php', 'laravel'],
  updatedAt: NOW,
};
const create = { server: 'cedar', cwd: '/home/dev/projects/meadow-hr', prompt: 'run the tests', name: 'meadow-hr-tests' };

describe('enums', () => {
  it('pins channel, session-state and action-status values', () => {
    for (const channel of ['web', 'phone', 'event', 'scheduled', 'remote_control', 'old-chat', 'test-channel']) {
      expect(ChannelSchema.safeParse(channel).success, channel).toBe(true);
    }
    for (const channel of ['chat', 'manager', 'hub', 'Web', 'x', 'a_b', '']) expect(ChannelSchema.safeParse(channel).success, channel).toBe(false);
    expect(SessionStateSchema.options).toEqual([
      'starting',
      'idle',
      'working',
      'waiting_question',
      'waiting_permission',
      'error',
      'ended',
    ]);
    expect(ActionStatusSchema.options).toEqual(['pending_confirmation', 'approved', 'denied', 'expired', 'done', 'failed']);
  });
});

describe('DTO schemas', () => {
  it.each([
    ['ServerDTO', ServerDTOSchema, server],
    ['SessionDTO', SessionDTOSchema, session],
    ['QuestionDTO (question)', QuestionDTOSchema, question],
    ['QuestionDTO (permission)', QuestionDTOSchema, permissionQuestion],
    ['ActionDTO', ActionDTOSchema, action],
    ['LuadyMessageSentDTO', LuadyMessageSentDTOSchema, { ok: true }],
    ['LuadyMessageSentDTO (held)', LuadyMessageSentDTOSchema, { ok: true, held: true }],
    ['ActionDTO of a resume', ActionDTOSchema, { ...action, kind: 'session.resume', resume: { wasHit: true, sent: false } }],
    ['ChatMessageDTO', ChatMessageDTOSchema, chat],
    ['TranscriptItemDTO', TranscriptItemDTOSchema, transcriptItem],
    ['LuadyStatusDTO', LuadyStatusDTOSchema, luady],
    ['LuadyStatusDTO of a manager switched off', LuadyStatusDTOSchema, { ...luady, state: 'off' }],
    ['ProjectDTO', ProjectDTOSchema, project],
    ['MeDTO', MeDTOSchema, { owner: 'owner@example.com', authMode: 'local', passkeys: 1, pinSet: true, csrf: 'c'.repeat(43) }],
    ['MeDTO in Cloudflare Access mode', MeDTOSchema, {
      owner: 'owner@example.com', authMode: 'cloudflare-access', passkeys: 0, pinSet: true, csrf: 'c'.repeat(43),
    }],
    ['OverviewDTO', OverviewDTOSchema, { servers: [server], sessions: [session], questions: [question], actions: [action], manager: luady, selfHost: 'hq', rooms: [], channels: [] }],
  ])('accepts a valid %s', (_name, schema, value) => {
    expect(schema.parse(value)).toEqual(value);
  });

  it.each([
    ['server whose name is not a host id', ServerDTOSchema, { ...server, name: 'Cedar' }],
    ['session in an unknown state', SessionDTOSchema, { ...session, state: 'sleeping' }],
    ['session from an unknown origin', SessionDTOSchema, { ...session, origin: 'cron' }],
    ['action with id A0', ActionDTOSchema, { ...action, id: 'A0' }],
    ['action with tier 2', ActionDTOSchema, { ...action, tier: 2 }],
    ['resume without sent', ActionDTOSchema, { ...action, resume: { wasHit: true } }],
    ['question in state cancelled', QuestionDTOSchema, { ...question, state: 'cancelled' }],
    ['luady status with a negative queue', LuadyStatusDTOSchema, { ...luady, queued: -1 }],
    ['luady status in an unknown state', LuadyStatusDTOSchema, { ...luady, state: 'paused' }],
    ['me with an unknown sign-in mode', MeDTOSchema, { owner: 'a', passkeys: 0, pinSet: false, csrf: 'c', authMode: 'oauth' }],
    ['me without the owner', MeDTOSchema, { authMode: 'local', passkeys: 0, pinSet: false, csrf: 'c' }],
    ['me without the sign-in mode', MeDTOSchema, { owner: 'a', passkeys: 0, pinSet: false, csrf: 'c' }],
  ])('rejects a %s', (_label, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('reads a ServerDTO and an OverviewDTO from an older hub with the defaults', () => {
    const { kind: _k, projectsRoot: _p, homeDir: _h, terminal: _t, ...older } = server;
    expect(ServerDTOSchema.parse(older)).toEqual(server);
    const overview = OverviewDTOSchema.parse({ servers: [older], sessions: [], questions: [], actions: [], manager: luady, selfHost: 'hq' });
    expect(overview).toMatchObject({ servers: [server], rooms: [], channels: [] });
  });

  it('pageSchema wraps items with a nullable cursor', () => {
    const page = pageSchema(ChatMessageDTOSchema);
    expect(page.parse({ items: [chat], nextCursor: null })).toEqual({ items: [chat], nextCursor: null });
    expect(page.parse({ items: [], nextCursor: 'c1' })).toEqual({ items: [], nextCursor: 'c1' });
    expect(page.safeParse({ items: [chat] }).success).toBe(false);
    expect(page.safeParse({ items: [{ ...chat, role: 'robot' }], nextCursor: null }).success).toBe(false);
  });
});

describe('request bodies', () => {
  it.each([
    ['CreateSessionBody', CreateSessionBodySchema, create],
    ['CreateSessionBody without prompt and name', CreateSessionBodySchema, { server: 'ash', cwd: '/home/dev/projects/harbor' }],
    ['SendBody', SendBodySchema, { text: '\u0645\u0631\u062d\u0628\u0627 \u2014 continue with step 2 \u{1F680}' }],
    ['PinBody', PinBodySchema, { pin: '123456' }],
    ['StopBody', StopBodySchema, { pin: '123456', force: true }],
    ['AnswerBody (question)', AnswerBodySchema, { answers: { 'Which database?': 'Postgres' } }],
    ['AnswerBody (permission)', AnswerBodySchema, { behavior: 'deny', message: 'not on prod' }],
    ['ExecBody without pin', ExecBodySchema, { command: 'git status', cwd: '/home/dev/projects/meadow-hr' }],
    ['FileWriteBody', FileWriteBodySchema, { path: '/home/dev/projects/x/.env.example', content: 'A=1\n', pin: '123456' }],
    ['SetPinBody (first set)', SetPinBodySchema, { newPin: '246810', setupCode: 'ABCD-1234' }],
    ['TerminalOpenBody', TerminalOpenBodySchema, { server: 'birch', target: 'cc-orchard:0.0', pin: '123456' }],
    ['PasskeyRegisterOptionsBody (empty)', PasskeyRegisterOptionsBodySchema, {}],
    ['PasskeyVerifyBody', PasskeyVerifyBodySchema, { response: { id: 'cred', type: 'public-key' }, label: 'iPhone' }],
  ])('accepts %s', (_name, schema, body) => {
    expect(schema.parse(body)).toEqual(body);
  });

  it.each([
    ['an empty cwd', CreateSessionBodySchema, { ...create, cwd: '' }],
    ['a cwd over 1024 chars', CreateSessionBodySchema, { ...create, cwd: `/${'x'.repeat(1024)}` }],
    ['a cwd that is not a string', CreateSessionBodySchema, { ...create, cwd: 42 }],
    ['a server id with a colon', CreateSessionBodySchema, { ...create, server: 'ce:dar' }],
    ['a server id in capitals', CreateSessionBodySchema, { ...create, server: 'CEDAR' }],
    ['a session name with a space', CreateSessionBodySchema, { ...create, name: 'two words' }],
    ['a prompt over 20000 chars', CreateSessionBodySchema, { ...create, prompt: 'x'.repeat(20001) }],
    ['an unknown key', CreateSessionBodySchema, { ...create, model: 'opus' }],
    ['empty text', SendBodySchema, { text: '' }],
    ['text over 20000 chars', SendBodySchema, { text: 'x'.repeat(20001) }],
    ['a 5-digit PIN', PinBodySchema, { pin: '12345' }],
    ['a PIN in Arabic-Indic digits', PinBodySchema, { pin: '\u0661\u0662\u0663\u0664\u0665\u0666' }],
    ['a PIN body with an extra key', PinBodySchema, { pin: '123456', remember: true }],
    ['a stop without PIN', StopBodySchema, { force: true }],
    ['answers and behavior together', AnswerBodySchema, { answers: { q: 'a' }, behavior: 'allow' }],
    ['an answer over 5000 chars', AnswerBodySchema, { answers: { q: 'x'.repeat(5001) } }],
    ['an empty answer body', AnswerBodySchema, {}],
    ['an empty command', ExecBodySchema, { command: '' }],
    ['a file write without PIN', FileWriteBodySchema, { path: '/home/dev/a', content: 'x' }],
    ['a 7-char setup code', SetPinBodySchema, { newPin: '246810', setupCode: 'ABC1234' }],
    ['a bad terminal target', TerminalOpenBodySchema, { server: 'birch', target: 'cc-orchard', pin: '123456' }],
    ['an unknown passkey option', PasskeyRegisterOptionsBodySchema, { userName: 'x' }],
    ['a passkey label over 64 chars', PasskeyVerifyBodySchema, { response: {}, label: 'x'.repeat(65) }],
  ])('rejects %s', (_label, schema, body) => {
    expect(schema.safeParse(body).success).toBe(false);
  });

  it('reports unknown body keys as unrecognized_keys', () => {
    const result = SendBodySchema.safeParse({ text: 'hi', html: '<b>hi</b>' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });
});

describe('permission questions with a preview and a risk', () => {
  const withPermission = (patch: Record<string, unknown>) => ({
    ...permissionQuestion,
    permission: { ...permissionQuestion.permission, ...patch },
  });

  it('parses a permission question without a preview or risk and adds no keys', () => {
    const parsed = QuestionDTOSchema.parse(permissionQuestion);
    expect(parsed).toEqual(permissionQuestion);
    expect(Object.keys(parsed.permission ?? {}).sort()).toEqual(['inputPreview', 'toolName']);
  });

  it.each([
    ['preview: null', { preview: null }],
    ['a full preview', { preview: PREVIEW }],
    ['a risk', { risk: { level: 'risky', reason: 'force push' } }],
    ['a preview and a risk', { preview: PREVIEW, risk: { level: 'safe', reason: 'read-only command' } }],
  ])('accepts %s', (_label, patch) => {
    const value = withPermission(patch);
    expect(QuestionDTOSchema.parse(value)).toEqual(value);
  });

  it.each([
    ['risk level "red"', { risk: { level: 'red', reason: 'x' } }],
    ['a risk reason over 200 characters', { risk: { level: 'normal', reason: 'x'.repeat(201) } }],
    ['a preview with 21 edits', { preview: { ...PREVIEW, edits: Array.from({ length: 21 }, () => ({ old: 'a', new: 'b' })) } }],
  ])('rejects %s', (_label, patch) => {
    expect(QuestionDTOSchema.safeParse(withPermission(patch)).success).toBe(false);
  });

  it('RiskDTOSchema pins the three levels', () => {
    expect(RiskDTOSchema.shape.level.options).toEqual(['safe', 'normal', 'risky']);
  });
});

describe('AnswerBodySchema with "Allow always"', () => {
  it('accepts allow always', () => {
    expect(AnswerBodySchema.parse({ behavior: 'allow', always: true })).toEqual({ behavior: 'allow', always: true });
  });

  it.each([[{ answers: { q: 'a' }, always: true }], [{ behavior: 'deny', always: false }], [{ behavior: 'allow', always: 'yes' }]])(
    'rejects %j',
    (body) => {
      expect(AnswerBodySchema.safeParse(body).success).toBe(false);
    },
  );
});

describe('API_ERROR_CODES', () => {
  it('pins the API error codes', () => {
    expect(API_ERROR_CODES).toEqual({ sessionPaused: 'session_paused', kitTooOld: 'kit_too_old' });
  });
});

describe('AnswerBodySchema: "always" belongs to allow only', () => {
  it.each([[{ behavior: 'deny', message: 'no' }], [{ behavior: 'allow' }], [{ behavior: 'allow', always: true }]])('accepts %j', (body) => {
    expect(AnswerBodySchema.parse(body)).toEqual(body);
  });

  it('rejects deny with always', () => {
    expect(AnswerBodySchema.safeParse({ behavior: 'deny', always: true }).success).toBe(false);
  });
});
