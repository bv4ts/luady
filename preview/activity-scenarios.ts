import { randomUUID } from 'node:crypto';
import type { PermissionPreview, TodoItem } from '@luady/shared';
import type { FakeKit, PreviewPane } from './fake-kit.ts';
import type { Driver, Scenario } from './scenarios.ts';

/** How long one tool runs in the preview; the next one starts right after. */
export const STEP_MS = 700;
const DEFAULT_STEPS = 6;
const MAX_STEPS = 200;
const HOUR_MS = 3_600_000;

interface StepSpec { readonly tool: string; readonly title: string; readonly added?: number; readonly removed?: number; readonly todos?: TodoItem[] }
interface Agent { readonly id: string; readonly type: string }
export type StepsOutcome = 'done' | 'paused' | 'stopped';

const TODO_SUBJECTS = ['Read the code', 'Fix the total', 'Add a test', 'Run the tests'];
const todoList = (firstDone: boolean): TodoItem[] => TODO_SUBJECTS.map((subject, i) => ({
  id: null, subject, status: i === 0 ? (firstDone ? 'completed' : 'in_progress') : i === 1 && firstDone ? 'in_progress' : 'pending',
}));

/** A plan, some reading and searching, an edit, the tests, then the plan with its first item done. */
const MAIN_STEPS: readonly StepSpec[] = [
  { tool: 'TodoWrite', title: '4 items', todos: todoList(false) },
  { tool: 'Read', title: 'src/app.ts' },
  { tool: 'Grep', title: '"TODO"' },
  { tool: 'Edit', title: 'src/app.ts', added: 12, removed: 3 },
  { tool: 'Bash', title: 'npm test' },
  { tool: 'TodoWrite', title: '4 items', todos: todoList(true) },
];
const HELPER_STEPS: readonly StepSpec[] = [
  { tool: 'Glob', title: '**/*.ts' },
  { tool: 'Read', title: 'src/index.ts' },
  { tool: 'Grep', title: '"export"' },
];

function mainStep(i: number): StepSpec {
  return MAIN_STEPS[i] ?? MAIN_STEPS[1 + ((i - MAIN_STEPS.length) % 4)] ?? { tool: 'Read', title: 'src/app.ts' };
}

const canWork = (kit: FakeKit, target: string): boolean => kit.pane(target)?.pendingQid === null;

async function oneStep(kit: FakeKit, target: string, spec: StepSpec, wait: Driver['wait'], agent: Agent | null): Promise<boolean> {
  const base = {
    tool: spec.tool, title: spec.title, tool_use_id: `toolu_preview_${randomUUID().slice(0, 12)}`,
    agent_id: agent?.id ?? null, agent_type: agent?.type ?? null,
  };
  kit.emit('tool_start', target, base);
  await wait(STEP_MS);
  if (kit.pane(target) === undefined) return false;
  const todos = spec.todos === undefined ? {} : { todos: spec.todos, todo_mode: 'replace' };
  kit.emit('tool_end', target, { ...base, ok: true, added: spec.added ?? null, removed: spec.removed ?? null, ...todos });
  return true;
}

/**
 * Tool steps like kit 2 spools them. The pause check runs after every tool, as the kit's: a paused pane stops after
 * its next step with a `paused` line and no Stop (measured: no Stop follows a pause).
 */
export async function runSteps(
  kit: FakeKit, target: string, count: number, wait: Driver['wait'], specs: (i: number) => StepSpec = mainStep, agent: Agent | null = null,
): Promise<{ outcome: StepsOutcome; ran: number }> {
  for (let i = 0; i < count; i += 1) {
    if (!canWork(kit, target) || !(await oneStep(kit, target, specs(i), wait, agent))) return { outcome: 'stopped', ran: i };
    if (kit.isPaused(target)) {
      kit.pauseHit(target);
      return { outcome: 'paused', ran: i + 1 };
    }
  }
  return { outcome: 'done', ran: count };
}

function countArg(text: string | undefined): number {
  const count = text === undefined ? DEFAULT_STEPS : Number(text);
  if (!Number.isInteger(count) || count < 1 || count > MAX_STEPS) throw new Error(`usage: steps <session> [count 1..${MAX_STEPS}]`);
  return count;
}

const stepsScenario: Scenario = async (driver, [ref, countText]) => {
  const count = countArg(countText);
  const { kit, pane } = driver.ref(ref ?? '');
  const { outcome, ran } = await runSteps(kit, pane.target, count, driver.wait);
  if (outcome === 'paused') return `${ref} ran ${ran} step and stopped: it is paused.`;
  return outcome === 'done' ? `${ref} ran ${ran} steps.` : `${ref} stopped after ${ran} steps.`;
};

const helperScenario: Scenario = async (driver, [ref]) => {
  const { kit, pane } = driver.ref(ref ?? '');
  const agent: Agent = { id: `agent-${randomUUID().slice(0, 8)}`, type: 'Explore' };
  kit.emit('subagent_start', pane.target, { agent_id: agent.id, agent_type: agent.type });
  await runSteps(kit, pane.target, HELPER_STEPS.length, driver.wait, (i) => HELPER_STEPS[i] ?? { tool: 'Read', title: '' }, agent);
  kit.emit('subagent_stop', pane.target, { agent_id: agent.id, agent_type: agent.type });
  return `${ref}: a helper (${agent.id}) ran three steps and stopped.`;
};

const METERS_USAGE = 'usage: meters <session> <context%> [5-hour%] [7-day%] (numbers 0..100)';

function pctArg(text: string | undefined, required: boolean): number | null {
  if (text === undefined && !required) return null;
  const value = Number(text);
  if (text === undefined || !Number.isFinite(value) || value < 0 || value > 100) throw new Error(METERS_USAGE);
  return value;
}

/** A missing window is null (unknown), never 0: Claude Code may leave either one out. */
const metersScenario: Scenario = async (driver, [ref, contextText, fiveText, sevenText]) => {
  const context = pctArg(contextText, true);
  const [five, seven] = [pctArg(fiveText, false), pctArg(sevenText, false)];
  const { kit, pane } = driver.ref(ref ?? '');
  const at = Date.now();
  const window = (used: number | null, ms: number) => (used === null ? null : { used_pct: used, resets_at: new Date(at + ms).toISOString() });
  kit.emit('meters', pane.target, {
    context_pct: context, model: 'Opus', cost_usd: 1.25, five_hour: window(five, 2 * HOUR_MS), seven_day: window(seven, 72 * HOUR_MS),
  });
  return `${ref} reports context ${context}%${five === null ? '' : `, 5-hour ${five}%`}${seven === null ? '' : `, 7-day ${seven}%`}.`;
};

const EDIT_OLD = 'export function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item.price;\n  return sum;\n}';
const EDIT_NEW = 'export function total(items: Item[]): number {\n  let sum = 0;\n  for (const item of items) sum += item.price * item.quantity;\n'
  + '  return Math.round(sum * 100) / 100;\n}';

function editPreview(pane: PreviewPane): PermissionPreview {
  return {
    tool: 'Edit', kind: 'edit', command: null, path: `${pane.cwd}/src/app.ts`, cwd: pane.cwd,
    edits: [{ old: EDIT_OLD, new: EDIT_NEW }], truncated: false, always: { label: 'Edit' },
  };
}

const DEFAULT_COMMAND = 'npm test -- --run';
/** Commands the fake kit never offers "Allow always" for, like Claude Code's own rule for risky ones. */
const NO_ALWAYS = /--force|\breset --hard\b|\brm -r|\bdrop\b|\bdeploy\b/i;

/** Kit 2's preview of a Bash permission: the whole command, the folder it runs in, and what "Allow always" would allow. */
function commandPreview(pane: PreviewPane, command: string): PermissionPreview {
  const words = command.trim().split(/\s+/).slice(0, 2).join(' ');
  return {
    tool: 'Bash', kind: 'command', command, path: null, cwd: pane.cwd, edits: [], truncated: false,
    always: NO_ALWAYS.test(command) ? null : { label: `${words} commands` },
  };
}

export interface ScenarioHelpers {
  idleRef(driver: Driver, sessionRef: string | undefined): { kit: FakeKit; pane: PreviewPane };
  work(kit: FakeKit, pane: PreviewPane, text: string): void;
}

/** The kit-2 scenarios; `helpers` come from scenarios.ts so this module never imports its values. */
export function activityScenarios(helpers: ScenarioHelpers): Readonly<Record<string, Scenario>> {
  const permitEdit: Scenario = async (driver, [ref]) => {
    const { kit, pane } = helpers.idleRef(driver, ref);
    helpers.work(kit, pane, 'Continue');
    const preview = editPreview(pane);
    const input = JSON.stringify({ file_path: preview.path, old_string: EDIT_OLD, new_string: EDIT_NEW });
    const qid = kit.permit(pane.target, 'Edit', input, { preview });
    return `${ref} asks permission #${qid} to edit src/app.ts.`;
  };
  const permitCommand: Scenario = async (driver, [ref, commandText]) => {
    const { kit, pane } = helpers.idleRef(driver, ref);
    helpers.work(kit, pane, 'Continue');
    const command = commandText ?? DEFAULT_COMMAND;
    const qid = kit.permit(pane.target, 'Bash', command, { preview: commandPreview(pane, command) });
    return `${ref} asks permission #${qid} to run ${command}.`;
  };
  return { steps: stepsScenario, helper: helperScenario, meters: metersScenario, 'permit-edit': permitEdit, 'permit-command': permitCommand };
}
