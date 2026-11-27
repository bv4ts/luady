import { promptHash, type ActivitySpoolEvent, type AskQuestion, type PermissionPreview, type SpoolEvent, type TodoItem } from '@luady/shared';

type Envelope = Omit<SpoolEvent, 'event' | 'data'>;
export type EventOverrides = Partial<Envelope>;

let sequence = 0;

function envelope(over: EventOverrides): Envelope {
  sequence += 1;
  return {
    v: 1,
    id: `evt-${String(sequence).padStart(8, '0')}`,
    ts: '2026-10-09T12:00:00.000Z',
    host: 'cedar',
    session_id: 'claude-a',
    cwd: '/home/dev/projects/meadow-hr',
    transcript_path: '/home/dev/.claude/projects/-home-dev-projects-meadow-hr/claude-a.jsonl',
    tmux: 'cc-meadow-hr:0.0',
    permission_mode: 'bypassPermissions',
    ...over,
  };
}

export function sessionStart(source: string, over: EventOverrides = {}): SpoolEvent {
  return { ...envelope(over), event: 'session_start', data: { source, model: 'opus' } };
}

export function prompt(text: string, over: EventOverrides = {}): SpoolEvent {
  return { ...envelope(over), event: 'prompt', data: { prompt_sha256: promptHash(text), prompt_preview: text.slice(0, 200) } };
}

export function stop(message: string, over: EventOverrides = {}): SpoolEvent {
  return { ...envelope(over), event: 'stop', data: { last_assistant_message: message, truncated: false } };
}

export function report(text: string, over: EventOverrides = {}): SpoolEvent {
  return { ...envelope({ session_id: null, cwd: null, ...over }), event: 'report', data: { text } };
}

export function stopFailure(error: string, over: EventOverrides = {}): SpoolEvent {
  return { ...envelope(over), event: 'stop_failure', data: { error } };
}

export function notification(type: string, message: string, over: EventOverrides = {}): SpoolEvent {
  return { ...envelope(over), event: 'notification', data: { notification_type: type, message, title: null } };
}

export function sessionEnd(reason: string, over: EventOverrides = {}): SpoolEvent {
  return { ...envelope(over), event: 'session_end', data: { reason } };
}

export function question(qid: string, questions: AskQuestion[], over: EventOverrides = {}): SpoolEvent {
  return { ...envelope(over), event: 'question', data: { qid, tool_use_id: 'toolu_01Ask', questions } };
}

export function questionResolved(
  qid: string,
  outcome: 'answered' | 'released' | 'timeout' | 'error',
  over: EventOverrides = {},
): SpoolEvent {
  return { ...envelope(over), event: 'question_resolved', data: { qid, outcome } };
}

export function permission(qid: string, toolName: string, preview: string, over: EventOverrides = {}): SpoolEvent {
  return { ...envelope(over), event: 'permission', data: { qid, tool_name: toolName, input_preview: preview } };
}

/** A kit-2 `permission` event carrying a structured preview. */
export function permissionWithPreview(
  qid: string,
  toolName: string,
  inputPreview: string,
  preview: PermissionPreview,
  over: EventOverrides = {},
): SpoolEvent {
  return { ...envelope(over), event: 'permission', data: { qid, tool_name: toolName, input_preview: inputPreview, preview } };
}

export function permissionResolved(
  qid: string,
  outcome: 'allowed' | 'denied' | 'released' | 'timeout' | 'error',
  over: EventOverrides = {},
): SpoolEvent {
  return { ...envelope(over), event: 'permission_resolved', data: { qid, outcome } };
}

// ── Kit-2 activity events (ActivitySpoolEventSchema) ───────────────────────

type StepOverrides = EventOverrides & { toolUseId?: string; agentId?: string };
type EndOverrides = StepOverrides & { ok?: boolean; added?: number; removed?: number; todos?: TodoItem[]; todoMode?: 'replace' | 'merge' };
type MetersData = Extract<ActivitySpoolEvent, { event: 'meters' }>['data'];

function stepData(tool: string, title: string, over: StepOverrides) {
  return {
    tool,
    title,
    tool_use_id: over.toolUseId ?? null,
    agent_id: over.agentId ?? null,
    agent_type: over.agentId === undefined ? null : 'general-purpose',
  };
}

function envelopeOnly(over: EventOverrides & Record<string, unknown>): EventOverrides {
  const { toolUseId: _a, agentId: _b, ok: _c, added: _d, removed: _e, todos: _f, todoMode: _g, ...rest } = over;
  return rest;
}

export function toolStart(tool: string, title: string, over: StepOverrides = {}): ActivitySpoolEvent {
  return { ...envelope(envelopeOnly(over)), event: 'tool_start', data: stepData(tool, title, over) };
}

export function toolEnd(tool: string, title: string, over: EndOverrides = {}): ActivitySpoolEvent {
  const data = {
    ...stepData(tool, title, over),
    ok: over.ok ?? true,
    added: over.added ?? null,
    removed: over.removed ?? null,
    ...(over.todos === undefined ? {} : { todos: over.todos }),
    ...(over.todoMode === undefined ? {} : { todo_mode: over.todoMode }),
  };
  return { ...envelope(envelopeOnly(over)), event: 'tool_end', data };
}

export function subagent(kind: 'start' | 'stop', agentId: string, over: EventOverrides = {}): ActivitySpoolEvent {
  const data = { agent_id: agentId, agent_type: 'general-purpose' };
  return kind === 'start'
    ? { ...envelope(over), event: 'subagent_start', data }
    : { ...envelope(over), event: 'subagent_stop', data };
}

export function meters(data: Partial<MetersData>, over: EventOverrides = {}): ActivitySpoolEvent {
  const full: MetersData = { context_pct: null, model: 'claude-opus-4-1', cost_usd: null, five_hour: null, seven_day: null, ...data };
  return { ...envelope(over), event: 'meters', data: full };
}

export function pausedEvent(over: EventOverrides = {}): ActivitySpoolEvent {
  return { ...envelope(over), event: 'paused', data: {} };
}
