import {
  LIMITS,
  toolKindOf,
  type ActivitySpoolEvent,
  type HelperDTO,
  type SessionActivityDTO,
  type SessionDetailDTO,
  type SessionMetersDTO,
  type StepDTO,
  type TodoItem,
} from '@luady/shared';
import { clipUnits } from '../board/text.js';
import { normalizeTs } from '../sessions/registry.js';

/** One session's recent activity, in memory only. Records are replaced on every change, never mutated. */
export interface SessionActivity {
  readonly sessionId: string;
  /** Oldest first, at most LIMITS.stepRingSize. */
  readonly steps: readonly StepDTO[];
  readonly todos: readonly TodoItem[];
  readonly helpers: readonly HelperDTO[];
  readonly meters: SessionMetersDTO | null;
  readonly lastStepAt: string | null;
  /** When the pause check really stopped the session; null = not stopped (or running again since). */
  readonly pauseHitAt: string | null;
}

type StepEvent = Extract<ActivitySpoolEvent, { event: 'tool_start' | 'tool_end' }>;
type ToolEndEvent = Extract<ActivitySpoolEvent, { event: 'tool_end' }>;
type HelperEvent = Extract<ActivitySpoolEvent, { event: 'subagent_start' | 'subagent_stop' }>;
type MetersEvent = Extract<ActivitySpoolEvent, { event: 'meters' }>;
type PausedEvent = Extract<ActivitySpoolEvent, { event: 'paused' }>;

/** Helpers live only within a turn; this cap only guards against lost `subagent_stop` lines. */
const HELPERS_MAX = LIMITS.stepRingSize;

export function emptyActivity(sessionId: string): SessionActivity {
  return { sessionId, steps: [], todos: [], helpers: [], meters: null, lastStepAt: null, pauseHitAt: null };
}

function stepId(event: StepEvent): string {
  return event.data.tool_use_id ?? event.id;
}

function openStep(event: StepEvent, ts: string): StepDTO {
  const { tool, title, agent_id: agentId, agent_type: agentType } = event.data;
  return {
    id: stepId(event), tool, kind: toolKindOf(tool), title, agentId, agentType,
    startedAt: ts, endedAt: null, ok: null, added: null, removed: null,
  };
}

/** Replaces the step with the same id in place, or appends it and keeps the newest LIMITS.stepRingSize. */
function upsertStep(steps: readonly StepDTO[], step: StepDTO): readonly StepDTO[] {
  const index = steps.findIndex((item) => item.id === step.id);
  if (index >= 0) return steps.map((item, i) => (i === index ? step : item));
  return [...steps, step].slice(-LIMITS.stepRingSize);
}

function later(current: string | null, ts: string): string {
  return current !== null && current > ts ? current : ts;
}

function onToolStart(prev: SessionActivity, event: StepEvent): SessionActivity {
  const ts = normalizeTs(event.ts);
  const existing = prev.steps.find((item) => item.id === stepId(event));
  // Step hooks run asynchronously, so a fast tool's end can be spooled before its start: keep that step closed.
  const step = existing !== undefined && existing.endedAt !== null
    ? { ...existing, startedAt: existing.startedAt < ts ? existing.startedAt : ts }
    : openStep(event, ts);
  return { ...prev, steps: upsertStep(prev.steps, step), lastStepAt: later(prev.lastStepAt, ts) };
}

function onToolEnd(prev: SessionActivity, event: ToolEndEvent): SessionActivity {
  const ts = normalizeTs(event.ts);
  const base = prev.steps.find((item) => item.id === stepId(event)) ?? openStep(event, ts);
  const closed: StepDTO = { ...base, endedAt: ts, ok: event.data.ok, added: event.data.added, removed: event.data.removed };
  const todos = event.data.todos === undefined ? prev.todos : mergeTodos(prev.todos, event.data.todos, event.data.todo_mode ?? 'replace');
  return { ...prev, steps: upsertStep(prev.steps, closed), todos, lastStepAt: later(prev.lastStepAt, ts) };
}

/** A replayed end closes the step only if it is still open; it never adds one, and its to-dos are old news. */
function closeReplayed(prev: SessionActivity, event: ToolEndEvent): SessionActivity {
  const open = prev.steps.find((item) => item.id === stepId(event) && item.endedAt === null);
  if (open === undefined) return prev;
  const closed: StepDTO = { ...open, endedAt: normalizeTs(event.ts), ok: event.data.ok, added: event.data.added, removed: event.data.removed };
  return { ...prev, steps: upsertStep(prev.steps, closed) };
}

function addHelper(prev: SessionActivity, event: HelperEvent): SessionActivity {
  if (prev.helpers.some((helper) => helper.agentId === event.data.agent_id)) return prev;
  const helper: HelperDTO = { agentId: event.data.agent_id, agentType: event.data.agent_type, startedAt: normalizeTs(event.ts) };
  return { ...prev, helpers: [...prev.helpers, helper].slice(-HELPERS_MAX) };
}

function closeSteps(steps: readonly StepDTO[], atIso: string, shouldClose: (step: StepDTO) => boolean): readonly StepDTO[] {
  const closing = (step: StepDTO): boolean => step.endedAt === null && shouldClose(step);
  return steps.some(closing) ? steps.map((step) => (closing(step) ? { ...step, endedAt: atIso } : step)) : steps;
}

/** A helper's own stop removes it and closes its open steps. A stop for a helper never seen started is ignored. */
function removeHelper(prev: SessionActivity, event: HelperEvent): SessionActivity {
  const agentId = event.data.agent_id;
  if (!prev.helpers.some((helper) => helper.agentId === agentId)) return prev;
  const steps = closeSteps(prev.steps, normalizeTs(event.ts), (step) => step.agentId === agentId);
  return { ...prev, steps, helpers: prev.helpers.filter((helper) => helper.agentId !== agentId) };
}

/** The pause stopped the session: nothing runs any more, and a helper it stopped never sends its own stop. */
function onPaused(prev: SessionActivity, event: PausedEvent): SessionActivity {
  const at = normalizeTs(event.ts);
  const steps = closeSteps(prev.steps, at, () => true);
  const pauseHitAt = later(prev.pauseHitAt, at);
  if (pauseHitAt === prev.pauseHitAt && prev.helpers.length === 0 && steps === prev.steps) return prev;
  return { ...prev, steps, helpers: [], pauseHitAt };
}

/** When the step this event belongs to started: its own time for a start, the known start for an end (null if unknown). */
function stepStartedAt(prev: SessionActivity, event: StepEvent): string | null {
  if (event.event === 'tool_start') return normalizeTs(event.ts);
  return prev.steps.find((item) => item.id === stepId(event))?.startedAt ?? null;
}

/**
 * A step that started after the hit proves the session runs again (the kit also checks after a failed call, where
 * the stop may not take effect): the hit is cleared, the flag stays. The end of the tool that ran at the hit, an
 * older or replayed older step, and an end whose start is unknown prove nothing.
 */
function afterHit(prev: SessionActivity, next: SessionActivity, event: StepEvent): SessionActivity {
  if (next.pauseHitAt === null) return next;
  const startedAt = stepStartedAt(prev, event);
  return startedAt !== null && startedAt > next.pauseHitAt ? { ...next, pauseHitAt: null } : next;
}

function metersOf(event: MetersEvent): SessionMetersDTO {
  const { context_pct: contextPct, model, cost_usd: costUsd } = event.data;
  return { contextPct, model, costUsd, updatedAt: normalizeTs(event.ts) };
}

/**
 * Pure: the record after one activity event. A `replay` line (hours old, after an outage) never opens anything, so
 * it cannot make an idle character look busy, but it still closes a step or a helper that is open; meters and
 * `paused` apply as usual.
 */
export function applyActivity(prev: SessionActivity, event: ActivitySpoolEvent, replay: boolean): SessionActivity {
  switch (event.event) {
    case 'tool_start':
      return afterHit(prev, replay ? prev : onToolStart(prev, event), event);
    case 'tool_end':
      return afterHit(prev, replay ? closeReplayed(prev, event) : onToolEnd(prev, event), event);
    case 'subagent_start':
      return replay ? prev : addHelper(prev, event);
    case 'subagent_stop':
      return removeHelper(prev, event);
    case 'meters':
      return { ...prev, meters: metersOf(event) };
    case 'paused':
      return onPaused(prev, event);
  }
}

function mergeOne(list: readonly TodoItem[], item: TodoItem): readonly TodoItem[] {
  const index = item.id === null ? -1 : list.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [...list, item];
  return list.map((entry, i) =>
    i === index ? { ...entry, status: item.status, subject: item.subject === '' ? entry.subject : item.subject } : entry,
  );
}

/** Over the cap: drop the oldest completed item, else the oldest one. */
function capTodos(list: readonly TodoItem[]): readonly TodoItem[] {
  if (list.length <= LIMITS.stepTodosMax) return list;
  const completed = list.findIndex((entry) => entry.status === 'completed');
  const drop = completed >= 0 ? completed : 0;
  return capTodos(list.filter((_, i) => i !== drop));
}

/** `replace`: the call's whole list. `merge`: only the items the call touched, matched by `id`. */
export function mergeTodos(prev: readonly TodoItem[], items: readonly TodoItem[], mode: 'replace' | 'merge'): readonly TodoItem[] {
  if (mode === 'replace') return items.slice(0, LIMITS.stepTodosMax);
  return capTodos(items.reduce<readonly TodoItem[]>((list, item) => mergeOne(list, item), prev));
}

/** The newest open main-thread step, else the newest open step (a helper's), else null. */
export function currentStep(activity: SessionActivity): StepDTO | null {
  const open = activity.steps.filter((step) => step.endedAt === null);
  return open.findLast((step) => step.agentId === null) ?? open.at(-1) ?? null;
}

/** The newest moment a helper was seen: its start, or any start or end of one of its steps still in the ring. */
function lastSeen(activity: SessionActivity, helper: HelperDTO): string {
  return activity.steps
    .filter((step) => step.agentId === helper.agentId)
    .flatMap((step) => (step.endedAt === null ? [step.startedAt] : [step.startedAt, step.endedAt]))
    .reduce((latest, ts) => (ts > latest ? ts : latest), helper.startedAt);
}

/**
 * The main thread's turn is over: its open steps close (their `ok` stays unknown) and the pause hit is cleared.
 * Helpers run in the background and outlive a Stop, so they and their steps stay, except a helper that had no step
 * since `turnStartedAt` (its stop line was lost): it expires. Steps of a helper that is not running close too.
 */
export function endTurn(activity: SessionActivity, atIso: string, turnStartedAt: string | null = null): SessionActivity {
  const helpers = turnStartedAt === null
    ? activity.helpers
    : activity.helpers.filter((helper) => lastSeen(activity, helper) >= turnStartedAt);
  const running = new Set(helpers.map((helper) => helper.agentId));
  const steps = closeSteps(activity.steps, atIso, (step) => step.agentId === null || !running.has(step.agentId));
  const sameHelpers = helpers.length === activity.helpers.length;
  if (steps === activity.steps && sameHelpers && activity.pauseHitAt === null) return activity;
  return { ...activity, steps, helpers: sameHelpers ? activity.helpers : helpers, pauseHitAt: null };
}

/** Up to LIMITS.activityHelperTypesMax distinct helper types, in the order they started ("general" when untyped). */
export function helperTypesOf(helpers: readonly HelperDTO[]): string[] {
  const types = helpers.map((helper) => (helper.agentType ?? 'general').slice(0, 64));
  return [...new Set(types)].slice(0, LIMITS.activityHelperTypesMax);
}

/** The slim record that drives the map; context is rounded to a whole number here. `turnStartedAt`: the running turn. */
export function toMapView(activity: SessionActivity, paused: boolean, turnStartedAt: string | null = null): SessionActivityDTO {
  const contextPct = activity.meters?.contextPct ?? null;
  const step = currentStep(activity);
  return {
    sessionId: activity.sessionId,
    tool: step?.kind ?? null,
    paused,
    helpers: activity.helpers.length,
    contextPct: contextPct === null ? null : Math.round(contextPct),
    lastStepAt: activity.lastStepAt,
    title: step === null ? null : clipUnits(step.title, LIMITS.stepTitleMax),
    helperTypes: helperTypesOf(activity.helpers),
    turnStartedAt,
  };
}

export function toDetail(activity: SessionActivity, paused: boolean): SessionDetailDTO {
  return {
    sessionId: activity.sessionId,
    current: currentStep(activity),
    steps: [...activity.steps],
    todos: [...activity.todos],
    helpers: [...activity.helpers],
    meters: activity.meters,
    paused,
    pauseHit: activity.pauseHitAt !== null,
  };
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function sameMapView(a: SessionActivityDTO, b: SessionActivityDTO): boolean {
  return a.sessionId === b.sessionId && a.tool === b.tool && a.paused === b.paused && a.helpers === b.helpers
    && a.contextPct === b.contextPct && a.lastStepAt === b.lastStepAt && (a.title ?? null) === (b.title ?? null)
    && (a.turnStartedAt ?? null) === (b.turnStartedAt ?? null) && sameList(a.helperTypes ?? [], b.helperTypes ?? []);
}
