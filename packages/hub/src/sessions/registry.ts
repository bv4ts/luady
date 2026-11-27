import { isSelfHost, makeSessionId, type HostId, type SessionOrigin, type SessionState, type SpoolEvent } from '@luady/shared';
import { displayNameFor, projectFor, sessionIdForEvent } from './naming.js';

export type { SessionOrigin };

export interface SessionRow {
  id: string;
  host: HostId;
  tmuxTarget: string;
  claudeSessionId: string | null;
  transcriptPath: string | null;
  cwd: string | null;
  project: string | null;
  displayName: string;
  state: SessionState;
  origin: SessionOrigin;
  registered: boolean;
  createdAt: string;
  lastEventAt: string | null;
  turnStartedAt: string | null;
  turnRemote: boolean;
  pendingQid: string | null;
  unexpectedEnd: boolean;
}

export type SessionSignal =
  | { kind: 'turn_started'; promptSha256: string; preview: string }
  | { kind: 'turn_finished'; startedAt: string | null; remote: boolean; lastMessage: string }
  | { kind: 'failed'; error: string }
  | { kind: 'ended'; reason: string }
  | { kind: 'usage'; message: string }
  | { kind: 'report'; text: string };

export interface Reduction {
  row: SessionRow;
  signals: SessionSignal[];
}

/** SessionEnd reasons after which the same Claude process keeps running in the pane. */
const CONTINUING_END_REASONS: ReadonlySet<string> = new Set(['clear', 'resume']);
const USAGE_RE = /usage limit|rate limit|limit reached|quota/i;

export function normalizeTs(ts: string): string {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? ts : new Date(ms).toISOString();
}

export function createSessionRow(input: {
  host: HostId;
  target: string;
  createdAt: string;
  origin: SessionOrigin;
  cwd: string | null;
}): SessionRow {
  return {
    id: makeSessionId(input.host, input.target),
    host: input.host,
    tmuxTarget: input.target,
    claudeSessionId: null,
    transcriptPath: null,
    cwd: input.cwd,
    project: projectFor(input.cwd),
    displayName: displayNameFor(input.target),
    state: 'idle',
    origin: input.origin,
    registered: false,
    createdAt: input.createdAt,
    lastEventAt: null,
    turnStartedAt: null,
    turnRemote: false,
    pendingQid: null,
    unexpectedEnd: false,
  };
}

/** New Claude id on the same pane. compact (and clear while a question waits) keep the turn; anything else starts idle. */
function onSessionStart(row: SessionRow, claudeId: string | null, transcriptPath: string | null, source: string): SessionRow {
  const rebound: SessionRow = {
    ...row,
    claudeSessionId: claudeId ?? row.claudeSessionId,
    transcriptPath: transcriptPath ?? row.transcriptPath,
    registered: true,
    unexpectedEnd: false,
  };
  const live = row.state !== 'ended' && row.state !== 'starting';
  const keepsTurn = source === 'compact' || (source === 'clear' && row.pendingQid !== null);
  if (live && keepsTurn) return rebound;
  return { ...rebound, state: 'idle', pendingQid: null, turnStartedAt: null, turnRemote: false };
}

function onSessionEnd(row: SessionRow, claudeId: string | null, reason: string): Reduction {
  const stale = claudeId !== null && row.claudeSessionId !== null && claudeId !== row.claudeSessionId;
  if (stale || CONTINUING_END_REASONS.has(reason) || row.state === 'ended') return { row, signals: [] };
  return {
    row: { ...row, state: 'ended', pendingQid: null, turnStartedAt: null, turnRemote: false, unexpectedEnd: false },
    signals: [{ kind: 'ended', reason }],
  };
}

function onResolved(row: SessionRow, qid: string): SessionRow {
  if (row.pendingQid !== qid) return row;
  const waiting = row.state === 'waiting_question' || row.state === 'waiting_permission';
  return { ...row, pendingQid: null, state: waiting ? 'working' : row.state };
}

function usageSignals(type: string, message: string): SessionSignal[] {
  return type.startsWith('quota') || USAGE_RE.test(message) ? [{ kind: 'usage', message }] : [];
}

function applyEvent(row: SessionRow, event: SpoolEvent, ts: string): Reduction {
  switch (event.event) {
    case 'session_start':
      return { row: onSessionStart(row, event.session_id, event.transcript_path, event.data.source), signals: [] };
    case 'prompt':
      return {
        // Prompts accumulate until the next Stop; keep the earliest ts and any remote match.
        row: { ...row, state: 'working', turnStartedAt: row.turnStartedAt ?? ts, unexpectedEnd: false },
        signals: [{ kind: 'turn_started', promptSha256: event.data.prompt_sha256, preview: event.data.prompt_preview }],
      };
    case 'stop':
      return {
        row: { ...row, state: 'idle', turnStartedAt: null, turnRemote: false, pendingQid: null },
        signals: [{ kind: 'turn_finished', startedAt: row.turnStartedAt, remote: row.turnRemote, lastMessage: event.data.last_assistant_message }],
      };
    case 'stop_failure':
      return {
        row: { ...row, state: 'error', turnStartedAt: null, turnRemote: false, pendingQid: null },
        signals: [{ kind: 'failed', error: event.data.error }],
      };
    case 'notification':
      return { row, signals: usageSignals(event.data.notification_type, event.data.message) };
    case 'session_end':
      return onSessionEnd(row, event.session_id, event.data.reason);
    case 'question':
      return { row: { ...row, state: 'waiting_question', pendingQid: event.data.qid }, signals: [] };
    case 'permission':
      return { row: { ...row, state: 'waiting_permission', pendingQid: event.data.qid }, signals: [] };
    case 'question_resolved':
    case 'permission_resolved':
      return { row: onResolved(row, event.data.qid), signals: [] };
    case 'report':
      return { row, signals: [{ kind: 'report', text: event.data.text }] };
  }
}

/** Pure state machine: (row, spool event) → new row plus derived signals. Null when the event has no pane. */
export function reduceSession(prev: SessionRow | null, host: HostId, event: SpoolEvent): Reduction | null {
  const target = event.tmux;
  if (target === null || sessionIdForEvent(host, event) === null) return null;
  if (prev === null && event.event === 'session_end') return null;
  const ts = normalizeTs(event.ts);
  const base: SessionRow = prev ?? {
    ...createSessionRow({ host, target, createdAt: ts, origin: isSelfHost(host) ? 'system' : 'owner', cwd: event.cwd }),
    registered: true,
  };
  const cwd = event.cwd ?? base.cwd;
  return applyEvent({ ...base, cwd, project: projectFor(cwd), lastEventAt: ts }, event, ts);
}
