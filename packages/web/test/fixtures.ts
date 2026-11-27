import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import {
  DEFAULT_SETTINGS, SELF_HOST_ID,
  type AccountDTO, type AccountHostDTO, type AccountsDTO, type ActionDTO, type ChatMessageDTO, type CtlFileRead,
  type LuadyStatusDTO, type MeDTO, type NoticeDTO, type OverviewDTO, type PermissionPreview, type PresenceDTO,
  type ProjectDTO, type QuestionDTO, type ServerDTO, type SessionActivityDTO, type SessionDTO, type SessionDetailDTO,
  type Settings, type StepDTO, type TranscriptItemDTO, type ChannelInfoDTO,
} from '@luady/shared';
import type { PasskeyEntry } from '../src/api/schemas.js';

export const NOW = '2026-10-09T12:00:00.000Z';
export const SESSION_ID = 'cedar:cc-meadow-hr:0.0';

export function server(over: Partial<ServerDTO> = {}): ServerDTO {
  return {
    name: 'cedar', host: '192.0.2.13', status: 'online', lastSeenAt: NOW, claudeVersion: '2.1.295', kitVersion: '1.0.0',
    sysinfo: { load1: 0.42, load5: 0.31, mem_total_kb: 8_000_000, mem_avail_kb: 4_000_000, disk_free_kb: 20_971_520, uptime_s: 864_000 },
    kind: 'ssh', projectsRoot: null, homeDir: null, terminal: true,
    ...over,
  };
}

export function session(over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: SESSION_ID, host: 'cedar', target: 'cc-meadow-hr:0.0', claudeSessionId: 'c0ffee00-0000-4000-8000-000000000001',
    cwd: '/home/dev/projects/meadow-hr', project: 'meadow-hr', displayName: 'meadow-hr', state: 'idle', origin: 'owner',
    registered: true, lastEventAt: NOW, turnStartedAt: null, pendingQid: null, unexpectedEnd: false,
    ...over,
  };
}

export function question(over: Partial<QuestionDTO> = {}): QuestionDTO {
  return {
    qid: 'ABCDEFGH', kind: 'question', host: 'cedar', sessionId: SESSION_ID, sessionLabel: 'cedar · meadow-hr',
    questions: [{
      question: 'Which database?', header: 'Database', multiSelect: false,
      options: [{ label: 'Postgres', description: 'Relational, already in use' }, { label: 'SQLite', description: 'Single file' }],
    }],
    permission: null, state: 'pending', createdAt: NOW, resolvedAt: null, resolvedVia: null,
    ...over,
  };
}

export function permission(over: Partial<QuestionDTO> = {}): QuestionDTO {
  return question({
    qid: 'Q2W3E4R5', kind: 'permission', questions: [],
    permission: { toolName: 'Bash', inputPreview: 'rm -rf build/' },
    ...over,
  });
}

export function action(over: Partial<ActionDTO> = {}): ActionDTO {
  return {
    id: 'A7', actor: 'manager', channel: 'test-channel', kind: 'session.stop', tier: 1, summary: 'Stop cedar · meadow-hr',
    status: 'pending_confirmation', createdAt: NOW, decidedAt: null, result: null, error: null,
    ...over,
  };
}

export function chat(over: Partial<ChatMessageDTO> = {}): ChatMessageDTO {
  return { id: 'm1', thread: 'manager', role: 'manager', channel: 'web', text: 'All servers are healthy.', ts: NOW, ...over };
}

export function item(over: Partial<TranscriptItemDTO> = {}): TranscriptItemDTO {
  return { uuid: 'u1', role: 'assistant', text: 'Done.', ts: NOW, toolName: null, ...over };
}

export function luadyStatus(over: Partial<LuadyStatusDTO> = {}): LuadyStatusDTO {
  return { state: 'running', since: NOW, claudeSessionId: null, queued: 0, ...over };
}

/** A declared chat channel add-on, up. */
export function channelInfo(over: Partial<ChannelInfoDTO> = {}): ChannelInfoDTO {
  return {
    id: 'test-channel', kind: 'channel', name: 'Test chat', state: 'up', detail: null, since: NOW, primary: true, panel: null,
    capabilities: {
      text: true, files: false, edit: false, pin: false, revoke: false, typing: false, played: false, profile: false,
      replyQuote: false, voiceNotes: false, maxText: 4000, maxFileBytes: 0,
    },
    ...over,
  };
}

export function me(over: Partial<MeDTO> = {}): MeDTO {
  return { owner: 'owner@example.com', authMode: 'local', passkeys: 1, pinSet: true, csrf: 'csrf-token-1', ...over };
}

export function project(over: Partial<ProjectDTO> = {}): ProjectDTO {
  return {
    server: 'cedar', path: '/home/dev/projects/meadow-hr', name: 'meadow-hr', remote: 'git@github.com:example-org/meadow-hr.git',
    branch: 'main', commits: [{ hash: 'abc1234', date: NOW, subject: 'feat: payroll export' }], stack: ['php', 'laravel'],
    updatedAt: NOW, ...over,
  };
}

export function fileRead(over: Partial<CtlFileRead> = {}): CtlFileRead {
  return { path: '/home/dev/.claude/settings.json', size: 16, content: '{"model":"opus"}', truncated: false, ...over };
}

export function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...over };
}

export function overview(over: Partial<OverviewDTO> = {}): OverviewDTO {
  return {
    servers: [server()], sessions: [session()], questions: [question()], actions: [action()],
    manager: luadyStatus(), selfHost: SELF_HOST_ID, rooms: [], channels: [], ...over,
  };
}

export function passkey(over: Partial<PasskeyEntry> = {}): PasskeyEntry {
  return { id: 'cred-1', label: 'iPhone', createdAt: '2026-10-01T08:00:00.000Z', lastUsedAt: NOW, ...over };
}

/** The slim activity record of the default session: working on an edit. */
export function activityItem(over: Partial<SessionActivityDTO> = {}): SessionActivityDTO {
  return { sessionId: SESSION_ID, tool: 'edit', paused: false, helpers: 0, contextPct: 41, lastStepAt: NOW, ...over };
}

/** A finished Edit step of the default session. */
export function step(over: Partial<StepDTO> = {}): StepDTO {
  return {
    id: 'toolu_01', tool: 'Edit', kind: 'edit', title: 'Edit src/payroll/export.ts', agentId: null, agentType: null,
    startedAt: NOW, endedAt: NOW, ok: true, added: 12, removed: 3, ...over,
  };
}

/** The agent view's detail of the default session: one step, nothing open, no plan, no helpers. */
export function detail(over: Partial<SessionDetailDTO> = {}): SessionDetailDTO {
  return {
    sessionId: SESSION_ID, current: null, steps: [step()], todos: [], helpers: [],
    meters: { contextPct: 41, model: 'claude-opus-4-5', costUsd: 1.25, updatedAt: NOW }, paused: false, pauseHit: false,
    ...over,
  };
}

/** A result notice from Luady, unsettled, falling back to the chat in ten minutes. */
export function notice(over: Partial<NoticeDTO> = {}): NoticeDTO {
  return {
    id: 'n1', kind: 'result', text: 'The payroll export is done.', ref: { kind: 'session', id: SESSION_ID },
    createdAt: NOW, chatDueAt: '2026-10-09T12:10:00.000Z', chatSentAt: null, settledAt: null, settledVia: null, ...over,
  };
}

export function presence(over: Partial<PresenceDTO> = {}): PresenceDTO {
  return { mode: 'here', online: true, clients: 1, forcedUntil: null, ...over };
}

export function accountHost(over: Partial<AccountHostDTO> = {}): AccountHostDTO {
  return { host: 'cedar', loggedIn: true, expiresAt: '2026-10-25T05:00:00.000Z', checkedAt: NOW, loginPending: false, canLogout: true, ...over };
}

/** A Claude account on cedar that reports both limit windows. */
export function account(over: Partial<AccountDTO> = {}): AccountDTO {
  return {
    id: 'claude:org_max', provider: 'claude', email: 'owner@example.com', orgName: 'Personal', plan: 'max',
    hosts: [accountHost()],
    limits: {
      reported: 'yes',
      fiveHour: { usedPct: 62, resetsAt: '2026-10-09T15:00:00.000Z' },
      sevenDay: { usedPct: 41, resetsAt: '2026-10-11T05:00:00.000Z' },
      updatedAt: NOW,
    },
    isManager: false,
    ...over,
  };
}

export function accounts(over: Partial<AccountsDTO> = {}): AccountsDTO {
  return {
    accounts: [account()],
    connections: [{ id: 'test-channel', label: 'Test chat', state: 'connected', detail: 'up', connectUrl: null }],
    ...over,
  };
}

/** A kit-2 command preview offering "Allow always". */
export function permissionPreview(over: Partial<PermissionPreview> = {}): PermissionPreview {
  return {
    tool: 'Bash', kind: 'command', command: 'npm test -- --run', path: null, cwd: '/home/dev/projects/meadow-hr', edits: [],
    truncated: false, always: { label: 'npm test commands' }, ...over,
  };
}

export const CREATION_OPTIONS: PublicKeyCredentialCreationOptionsJSON = {
  challenge: 'Y2hhbGxlbmdlLWZvci1yZWdpc3RyYXRpb24',
  rp: { name: 'Luady', id: 'luady.example.com' },
  user: { id: 'b3duZXItMDE', name: 'owner@example.com', displayName: 'Alex' },
  pubKeyCredParams: [{ alg: -7, type: 'public-key' }, { alg: -257, type: 'public-key' }],
  timeout: 60000,
  attestation: 'none',
  excludeCredentials: [],
  authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
};

export const REQUEST_OPTIONS: PublicKeyCredentialRequestOptionsJSON = {
  challenge: 'Y2hhbGxlbmdlLWZvci1sb2dpbi0wMQ',
  rpId: 'luady.example.com',
  allowCredentials: [],
  userVerification: 'required',
  timeout: 60000,
};
