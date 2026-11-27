import { z } from 'zod';
import { LIMITS } from './limits.js';
import { SPOOL_ENVELOPE } from './spool.js';

/** The family of a tool step. The same ten values (and table) as `toolKind` in @luady/office. */
export const TOOL_KINDS = ['read', 'edit', 'run', 'search', 'web', 'skill', 'mail', 'agent', 'plan', 'other'] as const;
export const ToolKindSchema = z.enum(TOOL_KINDS);
export type ToolKind = (typeof TOOL_KINDS)[number];

const TOOL_KIND_BY_NAME: ReadonlyMap<string, ToolKind> = new Map<string, ToolKind>([
  ['Read', 'read'], ['NotebookRead', 'read'],
  ['Edit', 'edit'], ['Write', 'edit'], ['MultiEdit', 'edit'], ['NotebookEdit', 'edit'],
  ['Bash', 'run'], ['BashOutput', 'run'], ['KillShell', 'run'],
  ['Grep', 'search'], ['Glob', 'search'], ['LS', 'search'], ['ToolSearch', 'search'],
  ['WebFetch', 'web'], ['WebSearch', 'web'],
  ['Skill', 'skill'],
  ['Agent', 'agent'], ['Task', 'agent'],
  ['TodoWrite', 'plan'], ['TaskCreate', 'plan'], ['TaskUpdate', 'plan'], ['ExitPlanMode', 'plan'],
]);

/** The family of a Claude Code tool name. MCP tools and unknown names are 'other'; nothing maps to 'mail'. */
export function toolKindOf(toolName: string): ToolKind {
  return TOOL_KIND_BY_NAME.get(toolName) ?? 'other';
}

/** One entry of a session's to-do list as a tool call left it. */
export const TodoItemSchema = z.object({
  id: z.string().max(64).nullable(),
  subject: z.string().max(LIMITS.stepTodoSubjectMax),
  status: z.enum(['pending', 'in_progress', 'completed']),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

/** A plan-limit window as the kit writes it (the status line's Unix seconds, converted to ISO). */
export const RateWindowWireSchema = z.object({ used_pct: z.number().min(0).max(100), resets_at: z.iso.datetime({ offset: true }) });
export type RateWindowWire = z.infer<typeof RateWindowWireSchema>;

const step = {
  tool: z.string().min(1).max(LIMITS.toolNameMax),
  title: z.string().max(LIMITS.stepTitleMax),
  tool_use_id: z.string().max(128).nullable(),
  agent_id: z.string().max(128).nullable(),
  agent_type: z.string().max(64).nullable(),
};
const helper = { agent_id: z.string().min(1).max(128), agent_type: z.string().max(64).nullable() };

/**
 * High-volume kit events. Deliberately a separate union from SpoolEventSchema (same envelope, disjoint names),
 * so a step can never reach the `events` table or the session reducer.
 * - tool_start / tool_end: before and after a tool runs; both carry the tool name and the same title.
 *   `added`/`removed` are line counts for edit tools, null otherwise. `todos` is the to-do list as the call left it:
 *   `replace` = the whole list, `merge` = only the items this call touched (match by `id`).
 * - subagent_start / subagent_stop: a helper's life.
 * - meters: the status-line numbers; a window is null when Claude Code did not report it.
 * - paused: the pause check stopped the session just now.
 */
export const ActivitySpoolEventSchema = z.discriminatedUnion('event', [
  z.object({ ...SPOOL_ENVELOPE, event: z.literal('tool_start'), data: z.object(step) }),
  z.object({
    ...SPOOL_ENVELOPE,
    event: z.literal('tool_end'),
    data: z.object({
      ...step,
      ok: z.boolean(),
      added: z.number().int().min(0).nullable(),
      removed: z.number().int().min(0).nullable(),
      todos: z.array(TodoItemSchema).max(LIMITS.stepTodosMax).optional(),
      todo_mode: z.enum(['replace', 'merge']).optional(),
    }),
  }),
  z.object({ ...SPOOL_ENVELOPE, event: z.literal('subagent_start'), data: z.object(helper) }),
  z.object({ ...SPOOL_ENVELOPE, event: z.literal('subagent_stop'), data: z.object(helper) }),
  z.object({
    ...SPOOL_ENVELOPE,
    event: z.literal('meters'),
    data: z.object({
      context_pct: z.number().min(0).max(100).nullable(),
      model: z.string().max(64).nullable(),
      cost_usd: z.number().min(0).nullable(),
      five_hour: RateWindowWireSchema.nullable(),
      seven_day: RateWindowWireSchema.nullable(),
    }),
  }),
  z.object({ ...SPOOL_ENVELOPE, event: z.literal('paused'), data: z.object({}) }),
]);
export type ActivitySpoolEvent = z.infer<typeof ActivitySpoolEventSchema>;

export const ACTIVITY_EVENT_NAMES = ['tool_start', 'tool_end', 'subagent_start', 'subagent_stop', 'meters', 'paused'] as const;
export type ActivityEventName = (typeof ACTIVITY_EVENT_NAMES)[number];

/** True for the six activity names: the ingest router sends these lines to ActivitySpoolEventSchema, never to SpoolEventSchema. */
export function isActivityEventName(name: unknown): name is ActivityEventName {
  return typeof name === 'string' && (ACTIVITY_EVENT_NAMES as readonly string[]).includes(name);
}

/**
 * One tool step as the website sees it. A step is sent twice with the same `id`: when it starts
 * (`endedAt: null`, `ok: null`) and when it ends. Receivers replace by `id`.
 */
export const StepDTOSchema = z.object({
  /** The tool_use_id, or the spool event id when the tool call had none. */
  id: z.string(),
  tool: z.string(),
  kind: ToolKindSchema,
  title: z.string(),
  agentId: z.string().nullable(),
  agentType: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  ok: z.boolean().nullable(),
  added: z.number().int().nullable(),
  removed: z.number().int().nullable(),
});
export type StepDTO = z.infer<typeof StepDTOSchema>;

export const HelperDTOSchema = z.object({ agentId: z.string(), agentType: z.string().nullable(), startedAt: z.string() });
export type HelperDTO = z.infer<typeof HelperDTOSchema>;

export const RateWindowDTOSchema = z.object({ usedPct: z.number().min(0).max(100), resetsAt: z.string() });
export type RateWindowDTO = z.infer<typeof RateWindowDTOSchema>;

export const SessionMetersDTOSchema = z.object({
  contextPct: z.number().min(0).max(100).nullable(),
  model: z.string().nullable(),
  costUsd: z.number().nullable(),
  updatedAt: z.string(),
});
export type SessionMetersDTO = z.infer<typeof SessionMetersDTOSchema>;

/** The slim per-session record that drives the map. `contextPct` is rounded to a whole number here. */
export const SessionActivityDTOSchema = z.object({
  sessionId: z.string(),
  tool: ToolKindSchema.nullable(),
  paused: z.boolean(),
  helpers: z.number().int().min(0),
  contextPct: z.number().int().min(0).max(100).nullable(),
  lastStepAt: z.string().nullable(),
  /** The current step's title (optional, so an older hub still parses). */
  title: z.string().max(LIMITS.stepTitleMax).nullable().optional(),
  /** Up to three helper (sub-agent) types running now. */
  helperTypes: z.array(z.string().max(64)).max(LIMITS.activityHelperTypesMax).optional(),
  /** When the running turn started; null while idle. */
  turnStartedAt: z.string().nullable().optional(),
});
export type SessionActivityDTO = z.infer<typeof SessionActivityDTOSchema>;

/** Everything the open agent view shows about one session. `pauseHit`: the pause check actually stopped it (until then the pause is only requested). */
export const SessionDetailDTOSchema = z.object({
  sessionId: z.string(),
  current: StepDTOSchema.nullable(),
  /** Oldest first. */
  steps: z.array(StepDTOSchema).max(LIMITS.stepRingSize),
  todos: z.array(TodoItemSchema).max(LIMITS.stepTodosMax),
  helpers: z.array(HelperDTOSchema),
  meters: SessionMetersDTOSchema.nullable(),
  paused: z.boolean(),
  pauseHit: z.boolean(),
});
export type SessionDetailDTO = z.infer<typeof SessionDetailDTOSchema>;

export const ActivityListDTOSchema = z.object({ items: z.array(SessionActivityDTOSchema) });
export type ActivityListDTO = z.infer<typeof ActivityListDTOSchema>;
