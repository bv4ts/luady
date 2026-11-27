import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  DEFAULT_WEB_PREFS,
  type ActionDTO,
  type BoardItemDTO,
  type JiraIssueDetailDTO,
  type KbPageFullDTO,
  type NoteDTO,
  type ChatMessageDTO,
  type HostId,
  type LuadyStatusDTO,
  type NoticeDTO,
  type PresenceDTO,
  type ProjectDTO,
  type QuestionDTO,
  type ServerDTO,
  type SessionActivityDTO,
  type SessionDetailDTO,
  type SessionDTO,
  type SettingsPatch,
  type TranscriptItemDTO,
} from '@luady/shared';
import type {
  ActionRequest,
  ActionService,
  Fleet,
  HubConfig,
  LuadyService,
  PinService,
  ProjectsService,
  QuestionService,
  SessionService,
  SettingsService,
  SetupCodeService,
  ShellStream,
} from '../../src/core/contracts.js';
import { createBus } from '../../src/core/bus.js';
import { openMemoryDb } from '../../src/db/open.js';
import { createSessionStore, SESSION_COOKIE } from '../../src/web/auth/sessions.js';
import { DEFAULT_WEB_OPTIONS, type WebServerOptions } from '../../src/web/context.js';
import { buildWebServer, type TerminalTicketConsumer, type WebDeps } from '../../src/web/server.js';
import { DEMO_HOSTS, createFakeClock, createFakeCtl, silentLogger, classicHostLookups } from '../helpers/fakes.js';
import { loadedDefaults } from '../helpers/loaded-config.js';
import {
  OWNER_EMAIL,
  PUBLIC_ORIGIN,
  RP_ID,
  SESSION_SECRET,
  signAccessToken,
  TEST_AUD,
  TEST_TEAM,
  testAccessVerifier,
} from './fixtures.js';

export { OWNER_EMAIL, PUBLIC_ORIGIN, RP_ID } from './fixtures.js';

export type FakeClock = ReturnType<typeof createFakeClock>;
export const ISO = '2026-10-09T12:00:00.000Z';
export const SESSION_ID = 'cedar:cc-meadow-hr:0.0';
export const QID = 'ABCDEFGH';
export const INDEX_HTML = '<!doctype html><title>Luady</title><div id="root"></div>';
export const APP_JS = 'console.log("app");';

// ── DTO samples (valid shapes) ─────────────────────────────────────────────

export function sampleSession(over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: SESSION_ID,
    host: 'cedar',
    target: 'cc-meadow-hr:0.0',
    claudeSessionId: 'claude-1',
    cwd: '/home/dev/projects/meadow-hr',
    project: 'meadow-hr',
    displayName: 'meadow-hr',
    state: 'idle',
    origin: 'owner',
    registered: true,
    lastEventAt: ISO,
    turnStartedAt: null,
    pendingQid: null,
    unexpectedEnd: false,
    ...over,
  };
}

export const SYSTEM_SESSION: SessionDTO = sampleSession({
  id: 'hq:manager:0.0',
  host: 'hq',
  target: 'manager:0.0',
  claudeSessionId: null,
  cwd: '/home/luady/brain',
  project: 'brain',
  displayName: 'manager',
  origin: 'system',
});

export function sampleQuestion(over: Partial<QuestionDTO> = {}): QuestionDTO {
  return {
    qid: QID,
    kind: 'question',
    host: 'cedar',
    sessionId: SESSION_ID,
    sessionLabel: 'cedar · meadow-hr',
    questions: [{ question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
    permission: null,
    state: 'pending',
    createdAt: ISO,
    resolvedAt: null,
    resolvedVia: null,
    ...over,
  };
}

export function sampleAction(over: Partial<ActionDTO> = {}): ActionDTO {
  return {
    id: 'A1',
    actor: 'owner',
    channel: 'web',
    kind: 'session.send',
    tier: 0,
    summary: 'Send to cedar · meadow-hr',
    status: 'done',
    createdAt: ISO,
    decidedAt: null,
    result: 'sent',
    error: null,
    ...over,
  };
}

export const PENDING_ACTION: ActionDTO = sampleAction({
  id: 'A2',
  kind: 'session.stop',
  tier: 1,
  status: 'pending_confirmation',
  result: null,
});

export function sampleServer(over: Partial<ServerDTO> = {}): ServerDTO {
  return {
    name: 'cedar',
    host: '192.0.2.13',
    status: 'online',
    lastSeenAt: ISO,
    claudeVersion: '2.1.295',
    kitVersion: '1.0.0',
    sysinfo: null,
    kind: 'ssh', projectsRoot: null, homeDir: null, terminal: true,
    ...over,
  };
}

export function sampleProject(over: Partial<ProjectDTO> = {}): ProjectDTO {
  return {
    server: 'cedar',
    path: '/home/dev/projects/meadow-hr',
    name: 'meadow-hr',
    remote: null,
    branch: 'main',
    commits: [],
    stack: ['php', 'laravel'],
    updatedAt: ISO,
    ...over,
  };
}

export function sampleChat(over: Partial<ChatMessageDTO> = {}): ChatMessageDTO {
  return { id: 'msg-1', thread: 'manager', role: 'manager', channel: 'web', text: 'Hello from Luady', ts: ISO, ...over };
}

export function sampleItem(uuid: string, text = `text ${uuid}`): TranscriptItemDTO {
  return { uuid, role: 'assistant', text, ts: ISO, toolName: null };
}

export const LUADY_STATUS: LuadyStatusDTO = { state: 'running', since: ISO, claudeSessionId: 'luady-claude-1', queued: 0 };

// ── Service fakes (vi.fn so tests can assert on and override them) ─────────

export function fakeSessions(): SessionService {
  return {
    list: vi.fn(() => [sampleSession(), SYSTEM_SESSION]),
    get: vi.fn((id: string) => (id === SESSION_ID ? sampleSession() : undefined)),
    findByRef: vi.fn(() => undefined),
    send: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined),
    start: vi.fn(async () => sampleSession()),
    stop: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    transcript: vi.fn(async () => ({ items: [sampleItem('u1')], nextCursor: null })),
    condensed: vi.fn(async () => ''),
  };
}

export function fakeQuestions(): QuestionService {
  return {
    pending: vi.fn(() => [sampleQuestion()]),
    get: vi.fn(() => sampleQuestion()),
    answer: vi.fn(async () => sampleQuestion({ state: 'answered', resolvedAt: ISO, resolvedVia: 'web' })),
    answerPermission: vi.fn(async () =>
      sampleQuestion({ kind: 'permission', state: 'answered', resolvedAt: ISO, resolvedVia: 'web' }),
    ),
    release: vi.fn(async () => sampleQuestion({ state: 'released', resolvedAt: ISO, resolvedVia: 'web' })),
    markNotified: vi.fn(),
    markEscalated: vi.fn(),
  };
}

export function fakeActions(): ActionService {
  return {
    request: vi.fn(async (req: ActionRequest) => sampleAction({ kind: req.kind, tier: req.pin === undefined ? 0 : 1 })),
    confirm: vi.fn(async (id: string) => sampleAction({ id, tier: 1, status: 'done' })),
    deny: vi.fn(async (id: string) => sampleAction({ id, tier: 1, status: 'denied', result: null })),
    get: vi.fn(() => undefined),
    list: vi.fn(() => [sampleAction()]),
    pending: vi.fn(() => [PENDING_ACTION]),
    sweepExpired: vi.fn(() => 0),
    fullText: vi.fn((id: string) => (id === 'A7' ? 'the whole message' : undefined)),
  };
}

export function fakePin(): PinService {
  return { isSet: vi.fn(() => true), set: vi.fn(async () => undefined), verify: vi.fn(async () => undefined) };
}

export function fakeSetupCodes(): SetupCodeService {
  return { issue: vi.fn(() => 'SETUP-CODE-1'), consume: vi.fn(), check: vi.fn() };
}

export function fakeSettings(): SettingsService {
  return {
    get: vi.fn(() => DEFAULT_SETTINGS),
    update: vi.fn((patch: SettingsPatch) => ({ ...DEFAULT_SETTINGS, ...patch })),
  };
}

export function fakeLuady(): LuadyService {
  return {
    status: vi.fn(() => LUADY_STATUS),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    postOwnerMessage: vi.fn(async () => undefined),
    postEvent: vi.fn(async () => undefined),
    messages: vi.fn(() => ({ items: [sampleChat()], nextCursor: null })),
  };
}

export function sampleActivity(over: Partial<SessionActivityDTO> = {}): SessionActivityDTO {
  return { sessionId: SESSION_ID, tool: 'run', paused: false, helpers: 0, contextPct: 42, lastStepAt: ISO, ...over };
}

export function sampleDetail(sessionId: string = SESSION_ID): SessionDetailDTO {
  const step = {
    id: 'toolu_1', tool: 'Bash', kind: 'run' as const, title: 'npm test', agentId: null, agentType: null,
    startedAt: ISO, endedAt: null, ok: null, added: null, removed: null,
  };
  return { sessionId, current: step, steps: [step], todos: [], helpers: [], meters: null, paused: false, pauseHit: false };
}

export type FakeActivity = WebDeps['activity'];

export function fakeActivity(): FakeActivity {
  return {
    snapshot: vi.fn(() => [sampleActivity()]),
    detail: vi.fn((sessionId: string) => sampleDetail(sessionId)),
    watch: vi.fn(),
    unwatch: vi.fn(),
  };
}

export function fakePauses(): WebDeps['pauses'] {
  return { isPaused: vi.fn(() => false) };
}

export function sampleNotice(over: Partial<NoticeDTO> = {}): NoticeDTO {
  return {
    id: 'n_01', kind: 'result', text: 'Mission done', ref: { kind: 'session', id: SESSION_ID }, createdAt: ISO,
    chatDueAt: '2026-10-09T12:10:00.000Z', chatSentAt: null, settledAt: null, settledVia: null, ...over,
  };
}

export const PRESENCE_AWAY: PresenceDTO = { mode: 'chat', online: false, clients: 0, forcedUntil: null };

export function fakeNotices(): WebDeps['notices'] {
  return { list: vi.fn(() => [sampleNotice()]), ack: vi.fn(), webMessage: vi.fn() };
}

export function fakePresence(): WebDeps['presence'] {
  return {
    connect: vi.fn(), hello: vi.fn(), active: vi.fn(), disconnect: vi.fn(), state: vi.fn(() => PRESENCE_AWAY),
    sessionSaidHello: vi.fn(() => false), seen: vi.fn(), canAck: vi.fn(() => true),
    force: vi.fn((chat: boolean) => ({ ...PRESENCE_AWAY, forcedUntil: chat ? '2026-10-09T13:00:00.000Z' : null })),
  };
}

export const LOGIN_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=s1';

export function fakeAccounts(): WebDeps['accounts'] {
  return { list: vi.fn(async () => ({ accounts: [], connections: [] })) };
}

export function fakeLogin(): WebDeps['login'] {
  return {
    pending: vi.fn((host: HostId) => ({ host, url: LOGIN_URL, expiresAt: '2026-10-09T12:30:00.000Z' })),
    /** Every host signed out: a sign-in start is tier 0 in the stubbed route tests. */
    statuses: vi.fn(() => DEMO_HOSTS.map((host) => ({
      host, loggedIn: false, email: null, orgId: null, orgName: null, plan: null, expiresAt: null, checkedAt: ISO,
    }))),
    submit: vi.fn(async (host: HostId) => ({ host, ok: true, message: 'Login successful', loggedIn: true, expiresAt: null, brainRestarted: false })),
    refresh: vi.fn(async (host: HostId) => ({
      host, loggedIn: true, email: null, orgId: null, orgName: null, plan: null, expiresAt: null, checkedAt: ISO,
    })),
  };
}

export function fakeCodexLogin(): WebDeps['codexLogin'] {
  return {
    beginData: vi.fn(async () => ({ url: 'https://auth.openai.com/codex/device', code: 'AB12-CD34Z', expiresAt: ISO })),
    status: vi.fn(async () => 'out' as const),
  };
}

export function fakeProjects(): ProjectsService {
  return { list: vi.fn(() => [sampleProject()]), refresh: vi.fn(async () => undefined) };
}


// ── Fakes for the board, notes, said, kb, library and jira services ──

export function sampleCard(over: Partial<BoardItemDTO> = {}): BoardItemDTO {
  return {
    id: 12, title: 'Fix the checkout total', details: '', project: 'orchard', server: 'birch', source: 'web', sourceRef: null, state: 'open',
    today: false, priority: 0, auto: false, runId: null, sessionId: null, result: null, createdAt: ISO, updatedAt: ISO, doneAt: null,
    dueAt: null, snoozeUntil: null, ...over,
  };
}

export function sampleNote(over: Partial<NoteDTO> = {}): NoteDTO {
  return {
    id: 'n:4', kind: 'note', title: 'Stand-up', at: ISO, project: null, people: null, gist: null, summary: 'Login done', actionItems: null,
    ownerNotes: null, link: null, hasTranscript: false, editable: true, ...over,
  };
}

export function samplePage(over: Partial<KbPageFullDTO> = {}): KbPageFullDTO {
  return {
    id: 3, scope: 'global', server: null, project: null, slug: 'rules', title: 'Rules', tags: [], pinned: false, auto: false, size: 7,
    updatedAt: ISO, updatedBy: 'owner', body: 'Be kind', ...over,
  };
}

export function sampleTicket(over: Partial<JiraIssueDetailDTO> = {}): JiraIssueDetailDTO {
  return {
    key: 'ORC-123', summary: 'Login fails', type: 'Bug', status: { name: 'To Do', category: 'todo' }, priority: 'High', labels: [],
    updatedAt: ISO, sprint: null, parent: null, flagged: false, hasNews: false, url: 'https://orchard-demo.atlassian.net/browse/ORC-123',
    descriptionMd: '', reporter: null, assignee: null, createdAt: ISO, dueDate: null, comments: [], transitions: [], subtasks: [], ...over,
  };
}

export function fakeBoard(): WebDeps['board'] {
  return {
    list: vi.fn(() => [sampleCard()]),
    find: vi.fn(() => [sampleCard()]),
    get: vi.fn(() => sampleCard()),
    detail: vi.fn((id: number) => (id === 12 ? { item: sampleCard(), events: [], mission: null } : null)),
    add: vi.fn(async () => sampleCard()),
    update: vi.fn(async () => sampleCard({ state: 'done' })),
    remove: vi.fn(async () => undefined),
    delegate: vi.fn(async () => ({ runId: 'r_1', items: [sampleCard({ state: 'queued' })], manager: 'sent' as const })),
    briefFor: vi.fn(() => ''),
    link: vi.fn(async () => undefined),
    render: vi.fn(() => ''),
    missions: vi.fn(() => []),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

export function fakeNotesService(): WebDeps['notes'] {
  return {
    list: vi.fn(async () => [sampleNote()]),
    get: vi.fn(async (id: string) => (id === 'n:4' ? sampleNote() : null)),
    create: vi.fn(async () => sampleNote()),
    update: vi.fn(async () => sampleNote()),
    remove: vi.fn(async () => undefined),
    transcript: vi.fn(async () => ({ text: 'Hello', nextStart: null })),
    opened: vi.fn(async () => undefined),
    newCount: vi.fn(() => 0),
  };
}

export function fakeSaid(): WebDeps['said'] {
  return { list: vi.fn(() => []) };
}

export function fakeKb(): WebDeps['kb'] {
  return {
    list: vi.fn(() => ({ items: [samplePage()], syncedAt: {} })),
    get: vi.fn((id: number) => (id === 3 ? samplePage() : null)),
    create: vi.fn(async () => samplePage()),
    update: vi.fn(async () => samplePage()),
    remove: vi.fn(async () => undefined),
    write: vi.fn(async () => samplePage()),
    search: vi.fn(() => []),
    sync: vi.fn(async () => undefined),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

export function fakeLibrary(): WebDeps['library'] {
  return { get: vi.fn(async () => ({ offices: [], managerSkills: [] })), refresh: vi.fn(async () => undefined), start: vi.fn(), stop: vi.fn() };
}

export function fakeJira(): WebDeps['jira'] {
  return {
    sites: vi.fn(() => ({ sites: [] })),
    connect: vi.fn(async (server: HostId) => ({
      server, baseUrl: 'https://orchard-demo.atlassian.net', email: 'owner@example.com', displayName: null, connectedAt: ISO, lastOkAt: ISO,
      lastError: null, attention: null,
    })),
    disconnect: vi.fn(async () => undefined),
    board: vi.fn(async () => ({ view: 'sprint' as const, issues: [], columns: [], sprint: null, fetchedAt: ISO })),
    issue: vi.fn(async () => sampleTicket()),
    transition: vi.fn(async () => sampleTicket()),
    comment: vi.fn(async () => sampleTicket()),
    edit: vi.fn(async () => sampleTicket()),
    assign: vi.fn(async () => sampleTicket()),
    pick: vi.fn(() => 'birch' as const),
    search: vi.fn(async () => []),
    moveTo: vi.fn(async () => sampleTicket()),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

// ── Fakes for the recap, fleet-history, wins, timeline, links and prefs services ──

export function sampleLink(over: Partial<import('@luady/shared').LinkDTO> = {}): import('@luady/shared').LinkDTO {
  return { id: 1, server: 'birch', label: 'Staging', url: 'https://staging.orchard.example', position: 0, ...over };
}

export function fakeRecap(): WebDeps['recap'] {
  return {
    recap: vi.fn((since: Date) => ({
      since: since.toISOString(), until: ISO, finished: [], failed: [], waiting: [], meetings: [], cards: { added: 0, done: 0 },
      sessions: { started: 0, ended: 0 },
    })),
  };
}

/** The owner's channel as the action service sees it: `channel.unlink` only. */
export function fakeChannel(): { unlink: () => Promise<void> } {
  return { unlink: vi.fn(async () => undefined) };
}

export function fakeFleetHistory(): WebDeps['fleetHistory'] {
  return { history: vi.fn(() => ({ servers: [{ name: 'cedar' as const, points: [[1_763_190_000, 0.4, 51, 62] as [number, number, number, number]] }], accounts: [] })) };
}

export function fakeWins(): WebDeps['wins'] {
  return { wins: vi.fn(() => ({ items: [], byServer: {} })) };
}

export function fakeTimeline(): WebDeps['timeline'] {
  return { day: vi.fn((day: string) => ({ day, items: [] })) };
}

export function fakeLinks(): WebDeps['links'] {
  return {
    list: vi.fn(() => [sampleLink()]),
    create: vi.fn(async () => sampleLink()),
    update: vi.fn(async () => sampleLink({ position: 2 })),
    remove: vi.fn(async () => undefined),
  };
}

export function fakePrefs(): WebDeps['prefs'] {
  return { get: vi.fn(() => DEFAULT_WEB_PREFS), update: vi.fn(async () => ({ ...DEFAULT_WEB_PREFS, dayNight: false })) };
}

export function fakeScheduler(): WebDeps['scheduler'] {
  return {
    list: vi.fn(() => [{ id: 'S1', when: '0 9 * * 1-5', task: 'Morning check', nextRunAt: ISO }]),
    add: vi.fn((when: string, task: string) => ({ id: 'S2', when, task, nextRunAt: ISO })),
    cancel: vi.fn((id: string) => id === 'S1'),
  };
}

export type FakeShell = ShellStream & { emitData(data: string): void; emitExit(code: number | null): void };

export function createFakeShell(): FakeShell {
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(code: number | null) => void> = [];
  return {
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    onData: vi.fn((cb: (data: string) => void) => {
      dataListeners.push(cb);
    }),
    onExit: vi.fn((cb: (code: number | null) => void) => {
      exitListeners.push(cb);
    }),
    emitData: (data) => {
      for (const cb of dataListeners) cb(data);
    },
    emitExit: (code) => {
      for (const cb of exitListeners) cb(code);
    },
  };
}

export function fakeFleet(shell: ShellStream = createFakeShell()): Fleet {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    client: vi.fn(() => createFakeCtl()),
    servers: vi.fn(() => [sampleServer()]),
    openShell: vi.fn(async () => shell),
    ...classicHostLookups(), tailEvents: vi.fn(() => ({ stop: () => undefined, done: Promise.resolve() })),
  };
}

/** Single-use like the real TicketStore: consume returns the grant once, then null. */
export function fakeTickets(
  entries: Readonly<Record<string, { server: HostId; target?: string }>> = {},
): TerminalTicketConsumer {
  let remaining = new Map(Object.entries(entries));
  return {
    consume: vi.fn((ticket: string) => {
      const grant = remaining.get(ticket) ?? null;
      remaining = new Map([...remaining].filter(([key]) => key !== ticket));
      return grant;
    }),
  };
}

// ── Harness ────────────────────────────────────────────────────────────────

export interface HarnessDirs {
  root: string;
  webDir: string;
  brainDir: string;
}

export interface LoggedIn {
  sid: string;
  csrf: string;
  cookie: string;
}

export interface Harness {
  app: FastifyInstance;
  deps: WebDeps;
  clock: FakeClock;
  dirs: HarnessDirs;
  token: string;
  login(): LoggedIn;
  close(): Promise<void>;
}

export function makeDirs(): HarnessDirs {
  const root = mkdtempSync(join(tmpdir(), 'luady-web-'));
  const webDir = join(root, 'web');
  const brainDir = join(root, 'brain');
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  mkdirSync(brainDir, { recursive: true });
  writeFileSync(join(webDir, 'index.html'), INDEX_HTML);
  writeFileSync(join(webDir, 'assets', 'app.js'), APP_JS);
  return { root, webDir, brainDir };
}

export function testConfig(dirs: HarnessDirs): HubConfig {
  return {
    ...loadedDefaults(join(dirs.root, 'data')),
    servers: [],
    fleetKeyPath: join(dirs.root, 'fleet-key'),
    dataDir: join(dirs.root, 'data'),
    brainDir: dirs.brainDir,
    runDir: join(dirs.root, 'run'),
    webDir: dirs.webDir,
    webPort: 0,
    publicOrigin: PUBLIC_ORIGIN,
    rpId: RP_ID,
    ownerPhone: '447700900001',
    ownerEmail: OWNER_EMAIL,
    cfTeamDomain: TEST_TEAM,
    cfAccessAud: TEST_AUD,
    sessionSecret: SESSION_SECRET,
    hubSocketToken: 'b'.repeat(64),
    claudePath: '/home/luady/.local/bin/claude',
    localCtlPath: '/home/luady/.luady/bin/luady-ctl',
    remoteCtlPath: '~/.luady/bin/luady-ctl',
  };
}

function loginSession(app: FastifyInstance, deps: WebDeps): LoggedIn {
  const session = createSessionStore({ db: deps.db, clock: deps.clock }).create();
  return {
    sid: session.sid,
    csrf: session.csrf,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(app.signCookie(session.sid))}`,
  };
}

export async function createHarness(
  over: Partial<WebDeps> = {},
  options: Partial<WebServerOptions> = {},
): Promise<Harness> {
  const dirs = makeDirs();
  const clock = createFakeClock();
  const deps: WebDeps = {
    config: testConfig(dirs),
    db: openMemoryDb(),
    bus: createBus(),
    clock,
    log: silentLogger(),
    fleet: fakeFleet(),
    sessions: fakeSessions(),
    questions: fakeQuestions(),
    actions: fakeActions(),
    pin: fakePin(),
    setupCodes: fakeSetupCodes(),
    settings: fakeSettings(),
    luady: fakeLuady(),
    projects: fakeProjects(),
    tickets: fakeTickets(),
    activity: fakeActivity(),
    pauses: fakePauses(),
    notices: fakeNotices(),
    presence: fakePresence(),
    accounts: fakeAccounts(),
    login: fakeLogin(),
    codexLogin: fakeCodexLogin(),
    access: await testAccessVerifier(),
    classify: vi.fn(() => ({ tier: 0 as const, reason: 'read-only' })),
    board: fakeBoard(),
    notes: fakeNotesService(),
    said: fakeSaid(),
    kb: fakeKb(),
    library: fakeLibrary(),
    jira: fakeJira(),
    recap: fakeRecap(),
    fleetHistory: fakeFleetHistory(),
    wins: fakeWins(),
    timeline: fakeTimeline(),
    links: fakeLinks(),
    prefs: fakePrefs(),
    scheduler: fakeScheduler(),
    ...over,
  };
  const app = await buildWebServer(deps, { ...DEFAULT_WEB_OPTIONS, ...options });
  return {
    app,
    deps,
    clock,
    dirs,
    token: await signAccessToken(),
    login: () => loginSession(app, deps),
    close: async () => {
      await app.close();
      deps.db.close();
      rmSync(dirs.root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** Call once per test file; harnesses created through it are closed after each test. */
export function harnessFactory(): (over?: Partial<WebDeps>, options?: Partial<WebServerOptions>) => Promise<Harness> {
  const open: Harness[] = [];
  afterEach(async () => {
    const closing = open.splice(0);
    await Promise.all(closing.map((h) => h.close()));
  });
  return async (over = {}, options = {}) => {
    const h = await createHarness(over, options);
    open.push(h);
    return h;
  };
}

// ── Requests ───────────────────────────────────────────────────────────────

export interface CallOptions {
  session?: LoggedIn;
  /** undefined = the harness token; null = send no Access JWT. */
  token?: string | null;
  /** undefined = the public origin on mutating requests; null = no Origin header. */
  origin?: string | null;
  /** undefined = the session's CSRF token on mutating requests; null = no header. */
  csrf?: string | null;
  headers?: Record<string, string>;
}

export function requestHeaders(h: Harness, method: string, opts: CallOptions = {}): Record<string, string> {
  const mutating = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
  const token = opts.token === undefined ? h.token : opts.token;
  const origin = opts.origin === undefined ? (mutating ? PUBLIC_ORIGIN : null) : opts.origin;
  const csrf = opts.csrf === undefined ? (mutating ? (opts.session?.csrf ?? null) : null) : opts.csrf;
  return {
    ...(token === null ? {} : { 'cf-access-jwt-assertion': token }),
    ...(opts.session === undefined ? {} : { cookie: opts.session.cookie }),
    ...(origin === null ? {} : { origin }),
    ...(csrf === null ? {} : { 'x-hub-csrf': csrf }),
    ...opts.headers,
  };
}

export function call(
  h: Harness,
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: object,
  opts: CallOptions = {},
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method,
    url,
    headers: requestHeaders(h, method, opts),
    ...(body === undefined ? {} : { payload: body }),
  });
}

/** The `hub_sid=…` pair from a response's Set-Cookie header. */
export function cookieFrom(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const first = Array.isArray(header) ? header[0] : header;
  if (typeof first !== 'string') throw new Error('response has no set-cookie header');
  return first.split(';', 1)[0] ?? '';
}
