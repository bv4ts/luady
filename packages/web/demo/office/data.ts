import type {
  AccountDTO, AccountsDTO, ChatMessageDTO, HostDTO, NoticeDTO, PermissionPreview, QuestionDTO, ServerDTO, SessionActivityDTO,
  SessionDTO, SessionDetailDTO, StepDTO, TranscriptItemDTO,
} from '@luady/shared';
import { SELF_HOST_ID } from '@luady/shared';

/** Realistic fake hub data for the office demo: four servers, a dozen agents, live activity, notices and accounts. */

export const MINUTE = 60_000;
export const iso = (msFromNow: number): string => new Date(Date.now() + msFromNow).toISOString();

/** The fields every demo server shares: an SSH server with its terminal. */
const SSH = { kind: 'ssh', projectsRoot: null, homeDir: null, terminal: true } as const;

const sysinfo = (load1: number, availGb: number, diskGb: number) => ({
  load1, load5: load1 * 0.9, mem_total_kb: 8_000_000, mem_avail_kb: availGb * 1_000_000, disk_free_kb: diskGb * 1024 * 1024, uptime_s: 400_000,
});

export const SERVERS: readonly ServerDTO[] = [
  { name: 'cedar', host: 'cedar.internal', status: 'online', lastSeenAt: iso(-5_000), claudeVersion: '2.1.330', kitVersion: '2.0.0', sysinfo: sysinfo(0.6, 5, 60), ...SSH },
  { name: 'birch', host: 'birch.internal', status: 'online', lastSeenAt: iso(-5_000), claudeVersion: '2.1.330', kitVersion: '2.0.0', sysinfo: sysinfo(3.4, 1, 30), ...SSH },
  { name: 'ash', host: 'ash.internal', status: 'online', lastSeenAt: iso(-5_000), claudeVersion: '2.1.301', kitVersion: '1.4.0', sysinfo: sysinfo(1.8, 2.5, 6), ...SSH },
  { name: 'local', host: 'local', status: 'online', lastSeenAt: iso(-5_000), claudeVersion: '2.1.330', kitVersion: '2.0.0', sysinfo: sysinfo(0.3, 6, 80), ...SSH },
];

/** The same four as the hub's hosts list (`GET /api/hosts`): set up, pinned and online. */
export const HOSTS: readonly HostDTO[] = SERVERS.map((server) => ({
  id: server.name, kind: 'ssh', host: server.host, user: 'dev', port: 22, source: 'config', state: 'pinned', fingerprint: null,
  link: 'online', lastError: null, kitVersion: server.kitVersion, kitAlias: null, claudeVersion: server.claudeVersion, claudeSignedIn: true,
  projectsRoot: server.projectsRoot, homeDir: server.homeDir, terminal: true, fromAddr: null, createdAt: null, updatedAt: null,
}));

const agent = (host: SessionDTO['host'], name: string, over: Partial<SessionDTO> = {}): SessionDTO => ({
  id: `${host}:${name}:0.0`, host, target: `${name}:0.0`, claudeSessionId: null, cwd: `/home/dev/projects/${name}`, project: name,
  displayName: name, state: 'working', origin: 'owner', registered: true, lastEventAt: iso(-20_000), turnStartedAt: iso(-8 * MINUTE),
  pendingQid: null, unexpectedEnd: false, ...over,
});

export const SESSIONS: readonly SessionDTO[] = [
  agent('cedar', 'meadow-vat'),
  agent('cedar', 'meadow-api', { state: 'waiting_permission', pendingQid: 'QPERMAAA' }),
  agent('cedar', 'fitness-demo', { state: 'idle' }),
  agent('cedar', 'meadow-admin'),
  agent('birch', 'app-backend'),
  agent('birch', 'jira-1105', { state: 'waiting_question', pendingQid: 'QASKAAAA' }),
  agent('birch', 'client-preferences'),
  agent('birch', 'orchard-web'),
  agent('birch', 'store-desk'),
  agent('birch', 'figma-sync', { state: 'idle' }),
  agent('ash', 'harbor-web'),
  agent('ash', 'harbor-api', { state: 'waiting_permission', pendingQid: 'QPERMBBB' }),
  agent('local', 'client-sandbox'),
];

const idOf = (host: string, name: string): string => `${host}:${name}:0.0`;
export const FOCUS_AGENT = idOf('birch', 'app-backend');

const live = (host: string, name: string, over: Partial<SessionActivityDTO> = {}): SessionActivityDTO => ({
  sessionId: idOf(host, name), tool: null, paused: false, helpers: 0, contextPct: 35, lastStepAt: iso(-15_000), ...over,
});

export const ACTIVITY: readonly SessionActivityDTO[] = [
  live('cedar', 'meadow-vat', { tool: 'edit', contextPct: 48, title: 'Edit src/vat/returns.ts', turnStartedAt: iso(-23 * MINUTE) }),
  live('cedar', 'fitness-demo', { paused: true, contextPct: 61 }),
  live('cedar', 'meadow-admin', { tool: 'read', contextPct: 93, title: 'Read app/Http/Kernel.php', turnStartedAt: iso(-4 * MINUTE) }),
  live('birch', 'app-backend', {
    tool: 'agent', helpers: 4, contextPct: 72, title: 'Run the payroll tests', helperTypes: ['Explore', 'code-reviewer', 'tdd-guide'],
    turnStartedAt: iso(-71 * MINUTE),
  }),
  live('birch', 'client-preferences', { tool: 'search', title: 'Search "theme" in src', turnStartedAt: iso(-2 * MINUTE) }),
  live('birch', 'orchard-web', { tool: 'edit', paused: true }),
  live('birch', 'store-desk', { tool: 'web', helpers: 1, title: 'Fetch the store API docs', helperTypes: ['Explore'], turnStartedAt: iso(-12 * MINUTE) }),
  live('ash', 'harbor-web', { tool: 'skill', title: 'Use the frontend-design skill', turnStartedAt: iso(-40_000) }),
  live('local', 'client-sandbox', { tool: 'read', contextPct: 12, title: 'Read README.md', turnStartedAt: iso(-6 * MINUTE) }),
];

const STEP_SCRIPT: ReadonlyArray<readonly [string, StepDTO['kind'], string, number | null, number | null]> = [
  ['Read', 'read', 'Read src/payroll/export.ts', null, null],
  ['Grep', 'search', 'Search "formatDate" in src', null, null],
  ['Edit', 'edit', 'Edit src/payroll/export.ts', 12, 3],
  ['Bash', 'run', 'npm test -- payroll', null, null],
  ['Edit', 'edit', 'Edit src/payroll/csv.ts', 4, 4],
  ['Write', 'edit', 'Write src/payroll/README.md', 18, null],
  ['Bash', 'run', 'npm run lint', null, null],
  ['WebFetch', 'web', 'Fetch the CSV spec page', null, null],
  ['Read', 'read', 'Read test/payroll/export.test.ts', null, null],
  ['Edit', 'edit', 'Edit test/payroll/export.test.ts', 26, 2],
  ['Bash', 'run', 'npm test -- payroll --run', null, null],
];

export function stepAt(index: number, open: boolean): StepDTO {
  const entry = STEP_SCRIPT[index % STEP_SCRIPT.length] ?? STEP_SCRIPT[0]!;
  const [tool, kind, title, added, removed] = entry;
  return {
    id: `toolu_demo_${index}`, tool, kind, title, agentId: null, agentType: null,
    startedAt: iso(-(STEP_SCRIPT.length - index) * 40_000), endedAt: open ? null : iso(-(STEP_SCRIPT.length - index) * 40_000 + 9_000),
    ok: open ? null : index !== 3, added: open ? null : added, removed: open ? null : removed,
  };
}

export function detailOf(sessionId: string, activity: SessionActivityDTO | undefined): SessionDetailDTO {
  const busy = sessionId === FOCUS_AGENT;
  const steps = Array.from({ length: busy ? 10 : 3 }, (_, i) => stepAt(i, false));
  const current = busy ? stepAt(10, true) : null;
  return {
    sessionId, current, steps: current === null ? steps : [...steps, current],
    todos: busy ? [
      { id: '1', subject: 'Read the export code', status: 'completed' },
      { id: '2', subject: 'Fix the date format in the CSV', status: 'completed' },
      { id: '3', subject: 'Run the payroll tests', status: 'in_progress' },
      { id: '4', subject: 'Update the README', status: 'pending' },
    ] : [],
    helpers: busy ? [
      { agentId: 'h1', agentType: 'Explore', startedAt: iso(-3 * MINUTE) },
      { agentId: 'h2', agentType: 'general-purpose', startedAt: iso(-MINUTE) },
    ] : [],
    meters: { contextPct: activity?.contextPct ?? 35, model: 'claude-opus-4-5', costUsd: 2.4, updatedAt: iso(-10_000) },
    paused: activity?.paused ?? false,
    pauseHit: sessionId === idOf('cedar', 'fitness-demo'),
  };
}

const editPreview: PermissionPreview = {
  tool: 'Edit', kind: 'edit', command: null, path: '/home/dev/projects/meadow-api/src/routes/invoices.ts', cwd: null,
  edits: [{
    old: "import { Router } from 'express';\nimport { db } from '../db';\n\nconst router = Router();\nrouter.get('/invoices', list);\nexport default router;",
    new: "import { Router } from 'express';\nimport { db } from '../db';\nimport { requireOwner } from '../auth';\n\nconst router = Router();\nrouter.get('/invoices', requireOwner, list);\nexport default router;",
  }],
  truncated: false, always: { label: 'Edit files in meadow-api/src' },
};

const commandPreview: PermissionPreview = {
  tool: 'Bash', kind: 'command', command: 'rm -rf storage/cache && git push --force origin main', path: null,
  cwd: '/home/dev/projects/harbor-api', edits: [], truncated: false, always: null,
};

export const QUESTIONS: readonly QuestionDTO[] = [
  {
    qid: 'QPERMAAA', kind: 'permission', host: 'cedar', sessionId: idOf('cedar', 'meadow-api'), sessionLabel: 'cedar · meadow-api', questions: [],
    permission: { toolName: 'Edit', inputPreview: 'src/routes/invoices.ts', preview: editPreview, risk: { level: 'normal', reason: '' } },
    state: 'pending', createdAt: iso(-4 * MINUTE), resolvedAt: null, resolvedVia: null,
  },
  {
    qid: 'QPERMBBB', kind: 'permission', host: 'ash', sessionId: idOf('ash', 'harbor-api'), sessionLabel: 'ash · harbor-api', questions: [],
    permission: { toolName: 'Bash', inputPreview: commandPreview.command ?? '', preview: commandPreview, risk: { level: 'risky', reason: 'deletes files' } },
    state: 'pending', createdAt: iso(-2 * MINUTE), resolvedAt: null, resolvedVia: null,
  },
  {
    qid: 'QASKAAAA', kind: 'question', host: 'birch', sessionId: idOf('birch', 'jira-1105'), sessionLabel: 'birch · jira-1105',
    questions: [{
      question: 'Which payment provider should the refund use?', header: 'Refunds', multiSelect: false,
      options: [{ label: 'Stripe', description: 'The one checkout uses' }, { label: 'Tap', description: 'Local cards' }],
    }],
    permission: null, state: 'pending', createdAt: iso(-6 * MINUTE), resolvedAt: null, resolvedVia: null,
  },
];

export const NOTICES: readonly NoticeDTO[] = [
  {
    id: 'n_old_1', kind: 'result', text: 'The **meadow-vat** migration finished: 14 tables, no errors.', ref: { kind: 'session', id: idOf('cedar', 'meadow-vat') },
    createdAt: iso(-90 * MINUTE), chatDueAt: iso(-80 * MINUTE), chatSentAt: null, settledAt: iso(-89 * MINUTE), settledVia: 'web',
  },
  {
    id: 'n_old_2', kind: 'alert', text: 'Disk on **ash** is below 10 GB.', ref: null,
    createdAt: iso(-50 * MINUTE), chatDueAt: iso(-40 * MINUTE), chatSentAt: iso(-40 * MINUTE), settledAt: iso(-40 * MINUTE), settledVia: 'demo-chat',
  },
];

const hours = (h: number): string => iso(h * 3_600_000);
const host = (name: AccountDTO['hosts'][number]['host'], over: Partial<AccountDTO['hosts'][number]> = {}) => ({
  host: name, loggedIn: true, expiresAt: hours(24 * 20), checkedAt: iso(-10 * MINUTE), loginPending: false, canLogout: true, ...over,
});

export const ACCOUNTS: AccountsDTO = {
  accounts: [
    {
      id: 'claude:org_max', provider: 'claude', email: 'owner@example.com', orgName: 'Personal', plan: 'max', hosts: [host('cedar')],
      limits: { reported: 'yes', fiveHour: { usedPct: 96, resetsAt: hours(1.4) }, sevenDay: { usedPct: 62, resetsAt: hours(70) }, updatedAt: iso(-MINUTE) },
      isManager: false,
    },
    {
      id: 'claude:org_team_a', provider: 'claude', email: null, orgName: 'Team A', plan: 'team', hosts: [host('birch', { canLogout: true })],
      limits: { reported: 'no', fiveHour: null, sevenDay: null, updatedAt: iso(-2 * MINUTE) }, isManager: false,
    },
    {
      id: 'claude:host:ash', provider: 'claude', email: null, orgName: null, plan: null,
      hosts: [host('ash', { loggedIn: false, expiresAt: null, canLogout: false })],
      limits: { reported: 'unknown', fiveHour: null, sevenDay: null, updatedAt: null }, isManager: false,
    },
    {
      id: 'claude:org_luady', provider: 'claude', email: 'luady@example.com', orgName: 'Luady', plan: 'max',
      hosts: [host('local'), host(SELF_HOST_ID, { expiresAt: hours(30) })],
      limits: { reported: 'yes', fiveHour: { usedPct: 22, resetsAt: hours(3) }, sevenDay: null, updatedAt: iso(-3 * MINUTE) }, isManager: true,
    },
    {
      id: 'codex', provider: 'codex', email: null, orgName: null, plan: 'ChatGPT', hosts: [host(SELF_HOST_ID, { loggedIn: false, expiresAt: null })],
      limits: { reported: 'unknown', fiveHour: null, sevenDay: null, updatedAt: null }, isManager: false,
    },
  ],
  connections: [
    { id: 'demo-chat', label: 'Chat', state: 'connected', detail: 'up', connectUrl: null },
    { id: 'google', label: 'Google', state: 'connected', detail: 'owner@example.com', connectUrl: null },
    { id: 'imap', label: 'Mailbox', state: 'unavailable', detail: null, connectUrl: null },
    { id: 'wispr', label: 'Wispr Flow', state: 'not_connected', detail: 'Send /wispr in your chat to connect', connectUrl: null },
  ],
};

export const CHAT: readonly ChatMessageDTO[] = [
  { id: 'm1', thread: 'manager', role: 'owner', channel: 'web', text: 'How is the payroll export going?', ts: iso(-12 * MINUTE) },
  { id: 'm2', thread: 'manager', role: 'manager', channel: 'web', text: 'app-backend is running the payroll tests now.', ts: iso(-11 * MINUTE) },
];

export const TRANSCRIPT: readonly TranscriptItemDTO[] = [
  { uuid: 't1', role: 'user', text: 'Fix the date format in the payroll CSV export.', ts: iso(-9 * MINUTE), toolName: null },
  { uuid: 't2', role: 'assistant', text: 'The export uses `toLocaleDateString`; I will switch it to ISO dates and update the tests.', ts: iso(-8 * MINUTE), toolName: null },
  { uuid: 't3', role: 'tool', text: 'npm test -- payroll: 41 passed', ts: iso(-2 * MINUTE), toolName: 'Bash' },
];
