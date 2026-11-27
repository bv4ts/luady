/** What a live session state looks like on the map. */

export type Pose = 'walk' | 'sit' | 'type' | 'alert' | 'down' | 'sleep' | 'gone';
export type BubbleIcon =
  | 'dots' | 'check' | 'bang' | 'key' | 'cross' | 'zzz' | 'pencil' | 'book' | 'term' | 'search' | 'globe' | 'skill' | 'mail'
  | 'pause' | 'ask' | 'team' | 'list' | 'gear';
export type MonitorGlow = 'off' | 'work' | 'alert' | 'error';
export type ToolKind = 'read' | 'edit' | 'run' | 'search' | 'web' | 'skill' | 'mail' | 'agent' | 'plan' | 'other';

export interface VisualInput {
  readonly state: string;
  readonly idleMs: number;
  readonly silentMs: number;
  readonly tool?: ToolKind | null;
  readonly paused?: boolean;
}

export interface Visual { readonly pose: Pose; readonly bubble: BubbleIcon | null; readonly monitor: MonitorGlow; readonly needsOwner: boolean }

/** Idle this long: the creature dozes off. */
export const IDLE_SLEEP_MS = 300_000;
/** Working with no step this long: a "?" bubble. */
export const SILENT_WARN_MS = 600_000;

export const BUBBLE_ICONS: readonly BubbleIcon[] = Object.freeze([
  'dots', 'check', 'bang', 'key', 'cross', 'zzz', 'pencil', 'book', 'term', 'search', 'globe', 'skill', 'mail', 'pause', 'ask',
  'team', 'list', 'gear',
] as const);

const look = (pose: Pose, bubble: BubbleIcon | null, monitor: MonitorGlow, needsOwner = false): Visual => Object.freeze({ pose, bubble, monitor, needsOwner });

const FIXED: ReadonlyMap<string, Visual> = new Map([
  ['starting', look('walk', null, 'off')],
  ['waiting_question', look('alert', 'bang', 'alert', true)],
  ['waiting_permission', look('alert', 'key', 'alert', true)],
  ['error', look('down', 'cross', 'error')],
  ['ended', look('gone', null, 'off')],
]);

const PAUSED = look('sit', 'pause', 'off');
const IDLE = look('sit', null, 'off');
const ASLEEP = look('sleep', 'zzz', 'off');
const UNKNOWN = look('sit', 'dots', 'off');

/** Every tool kind has its own bubble, so helpers, planning and MCP tools do not look like thinking (dots). */
const TOOL_BUBBLE: ReadonlyMap<string, BubbleIcon> = new Map<ToolKind, BubbleIcon>([
  ['read', 'book'], ['edit', 'pencil'], ['run', 'term'], ['search', 'search'], ['web', 'globe'], ['skill', 'skill'], ['mail', 'mail'],
  ['agent', 'team'], ['plan', 'list'], ['other', 'gear'],
]);

const WORKING: ReadonlyMap<BubbleIcon, Visual> = new Map(
  (['dots', 'ask', ...TOOL_BUBBLE.values()] as BubbleIcon[]).map((b) => [b, look('type', b, 'work')] as const),
);

const working = (input: VisualInput): Visual => {
  const bubble = input.silentMs >= SILENT_WARN_MS ? 'ask' : (TOOL_BUBBLE.get(input.tool ?? '') ?? 'dots');
  return WORKING.get(bubble) ?? look('type', bubble, 'work');
};

/** Pose, bubble and monitor for a session. Unknown states (from a newer hub) sit with thinking dots. */
export function visualFor(input: VisualInput): Visual {
  const { state } = input;
  if ((state === 'working' || state === 'idle') && input.paused === true) return PAUSED;
  if (state === 'working') return working(input);
  if (state === 'idle') return input.idleMs >= IDLE_SLEEP_MS ? ASLEEP : IDLE;
  return FIXED.get(state) ?? UNKNOWN;
}

const TOOL_KINDS: ReadonlyMap<string, ToolKind> = new Map<string, ToolKind>([
  ['Read', 'read'], ['NotebookRead', 'read'],
  ['Edit', 'edit'], ['Write', 'edit'], ['MultiEdit', 'edit'], ['NotebookEdit', 'edit'],
  ['Bash', 'run'], ['BashOutput', 'run'], ['KillShell', 'run'],
  ['Grep', 'search'], ['Glob', 'search'], ['LS', 'search'], ['ToolSearch', 'search'],
  ['WebFetch', 'web'], ['WebSearch', 'web'],
  ['Skill', 'skill'],
  ['Agent', 'agent'], ['Task', 'agent'],
  ['TodoWrite', 'plan'], ['TaskCreate', 'plan'], ['TaskUpdate', 'plan'], ['ExitPlanMode', 'plan'],
]);

/** The family of a Claude Code tool name. MCP tools and names this package does not know are 'other'. */
export function toolKind(toolName: string): ToolKind {
  return TOOL_KINDS.get(toolName) ?? 'other';
}
