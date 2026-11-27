import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_EVENT_NAMES,
  ActivityListDTOSchema,
  ActivitySpoolEventSchema,
  HelperDTOSchema,
  RateWindowDTOSchema,
  SessionActivityDTOSchema,
  SessionDetailDTOSchema,
  SessionMetersDTOSchema,
  StepDTOSchema,
  TOOL_KINDS,
  ToolKindSchema,
  isActivityEventName,
  toolKindOf,
  type ActivityEventName,
} from '../src/activity.js';
import { SpoolEventSchema } from '../src/spool.js';
import { EVENT_TYPES, VALID_DATA, line } from './helpers.js';

const step = { tool: 'Bash', title: 'npm test', tool_use_id: 'toolu_1', agent_id: null, agent_type: null };
const todo = (n: number) => ({ id: `t${n}`, subject: `Item ${n}`, status: 'pending' });
const rateWindow = { used_pct: 12, resets_at: '2026-11-14T10:00:00Z' };

const ACTIVITY_DATA: Record<ActivityEventName, Record<string, unknown>> = {
  tool_start: step,
  tool_end: { ...step, ok: true, added: null, removed: null },
  subagent_start: { agent_id: 'agent_1', agent_type: 'Explore' },
  subagent_stop: { agent_id: 'agent_1', agent_type: null },
  meters: { context_pct: 41.5, model: 'claude-opus-4-5', cost_usd: 1.25, five_hour: rateWindow, seven_day: null },
  paused: {},
};

describe('ActivitySpoolEventSchema', () => {
  it.each(ACTIVITY_EVENT_NAMES)('accepts and round-trips a valid %s event', (event) => {
    const input = line(event, ACTIVITY_DATA[event]);
    expect(ActivitySpoolEventSchema.parse(input)).toEqual(input);
  });

  it('round-trips a tool_start line', () => {
    const parsed = ActivitySpoolEventSchema.parse(line('tool_start', step));
    expect(parsed.event).toBe('tool_start');
    expect(parsed.data).toEqual(step);
  });

  it.each(ACTIVITY_EVENT_NAMES)('rejects a wrong envelope (v: 2) on %s', (event) => {
    expect(ActivitySpoolEventSchema.safeParse(line(event, ACTIVITY_DATA[event], { v: 2 })).success).toBe(false);
  });

  it('accepts a 160-character title and rejects a 161-character one', () => {
    expect(ActivitySpoolEventSchema.safeParse(line('tool_start', { ...step, title: 'x'.repeat(160) })).success).toBe(true);
    expect(ActivitySpoolEventSchema.safeParse(line('tool_start', { ...step, title: 'x'.repeat(161) })).success).toBe(false);
    expect(ActivitySpoolEventSchema.safeParse(line('tool_end', { ...ACTIVITY_DATA.tool_end, title: 'x'.repeat(161) })).success).toBe(false);
  });

  it.each([
    ['an empty tool name', { ...step, tool: '' }],
    ['a 129-character tool name', { ...step, tool: 'x'.repeat(129) }],
    ['a missing tool_use_id', { tool: 'Bash', title: 't', agent_id: null, agent_type: null }],
  ])('rejects a tool_start with %s', (_label, data) => {
    expect(ActivitySpoolEventSchema.safeParse(line('tool_start', data)).success).toBe(false);
  });

  it('accepts a 100-character MCP tool name on tool_start and tool_end', () => {
    const tool = `mcp__${'s'.repeat(40)}__${'t'.repeat(53)}`;
    expect(tool).toHaveLength(100);
    expect(ActivitySpoolEventSchema.safeParse(line('tool_start', { ...step, tool })).success).toBe(true);
    expect(ActivitySpoolEventSchema.safeParse(line('tool_end', { ...ACTIVITY_DATA.tool_end, tool })).success).toBe(true);
    expect(ActivitySpoolEventSchema.safeParse(line('tool_end', { ...ACTIVITY_DATA.tool_end, tool: 'x'.repeat(129) })).success).toBe(false);
  });

  it('rejects tool_end without ok', () => {
    const { ok: _ok, ...withoutOk } = ACTIVITY_DATA.tool_end;
    expect(ActivitySpoolEventSchema.safeParse(line('tool_end', withoutOk)).success).toBe(false);
  });

  it('accepts 20 to-do items and rejects 21', () => {
    const items = (n: number) => Array.from({ length: n }, (_v, i) => todo(i));
    const end = (n: number) => line('tool_end', { ...ACTIVITY_DATA.tool_end, todos: items(n), todo_mode: 'replace' });
    expect(ActivitySpoolEventSchema.safeParse(end(20)).success).toBe(true);
    expect(ActivitySpoolEventSchema.safeParse(end(21)).success).toBe(false);
  });

  it('keeps a merge with to-do items and accepts a null to-do id', () => {
    const data = { ...ACTIVITY_DATA.tool_end, todos: [{ id: null, subject: 'Ship', status: 'completed' }], todo_mode: 'merge' };
    expect(ActivitySpoolEventSchema.parse(line('tool_end', data)).data).toEqual(data);
  });

  it.each([
    ['todo_mode append', { todo_mode: 'append' }],
    ['added -1', { added: -1 }],
    ['added 1.5', { added: 1.5 }],
    ['removed -3', { removed: -3 }],
    ['a to-do status of done', { todos: [{ id: 't1', subject: 'x', status: 'done' }] }],
    ['a 201-character to-do subject', { todos: [{ id: 't1', subject: 'x'.repeat(201), status: 'pending' }] }],
  ])('rejects tool_end with %s', (_label, patch) => {
    expect(ActivitySpoolEventSchema.safeParse(line('tool_end', { ...ACTIVITY_DATA.tool_end, ...patch })).success).toBe(false);
  });

  it('accepts line counts for edit tools', () => {
    const data = { ...ACTIVITY_DATA.tool_end, tool: 'Edit', title: 'src/a.ts', added: 3, removed: 0 };
    expect(ActivitySpoolEventSchema.safeParse(line('tool_end', data)).success).toBe(true);
  });

  it.each(['subagent_start', 'subagent_stop'] as const)('rejects %s with an empty agent_id', (event) => {
    expect(ActivitySpoolEventSchema.safeParse(line(event, { agent_id: '', agent_type: null })).success).toBe(false);
  });

  it('accepts meters with every value null', () => {
    const nulls = { context_pct: null, model: null, cost_usd: null, five_hour: null, seven_day: null };
    expect(ActivitySpoolEventSchema.parse(line('meters', nulls)).data).toEqual(nulls);
  });

  it.each([
    ['context_pct 101', { context_pct: 101 }],
    ['context_pct -1', { context_pct: -1 }],
    ['a negative cost', { cost_usd: -0.01 }],
    ['a window reset of "tomorrow"', { five_hour: { used_pct: 12, resets_at: 'tomorrow' } }],
    ['a window over 100 percent', { seven_day: { used_pct: 100.5, resets_at: '2026-11-14T10:00:00Z' } }],
  ])('rejects meters with %s', (_label, patch) => {
    expect(ActivitySpoolEventSchema.safeParse(line('meters', { ...ACTIVITY_DATA.meters, ...patch })).success).toBe(false);
  });

  it('accepts a window reset with a zone offset', () => {
    const data = { ...ACTIVITY_DATA.meters, seven_day: { used_pct: 0, resets_at: '2026-11-14T14:00:00+04:00' } };
    expect(ActivitySpoolEventSchema.safeParse(line('meters', data)).success).toBe(true);
  });

  it('accepts paused with an empty object', () => {
    expect(ActivitySpoolEventSchema.parse(line('paused', {})).data).toEqual({});
  });
});

describe('the two spool unions are disjoint', () => {
  it.each(ACTIVITY_EVENT_NAMES)('SpoolEventSchema rejects %s', (event) => {
    expect(SpoolEventSchema.safeParse(line(event, ACTIVITY_DATA[event])).success).toBe(false);
  });

  it.each(EVENT_TYPES)('ActivitySpoolEventSchema rejects %s', (event) => {
    expect(SpoolEventSchema.safeParse(line(event, VALID_DATA[event])).success).toBe(true);
    expect(ActivitySpoolEventSchema.safeParse(line(event, VALID_DATA[event])).success).toBe(false);
  });
});

describe('ACTIVITY_EVENT_NAMES and isActivityEventName', () => {
  it('lists the six names', () => {
    expect(ACTIVITY_EVENT_NAMES).toEqual(['tool_start', 'tool_end', 'subagent_start', 'subagent_stop', 'meters', 'paused']);
  });

  it.each([
    ['meters', true],
    ['tool_start', true],
    ['prompt', false],
    [undefined, false],
    [7, false],
    [null, false],
  ])('isActivityEventName(%j) is %s', (name, expected) => {
    expect(isActivityEventName(name)).toBe(expected);
  });
});

describe('TOOL_KINDS', () => {
  it('has exactly the ten kinds in order', () => {
    expect(TOOL_KINDS).toEqual(['read', 'edit', 'run', 'search', 'web', 'skill', 'mail', 'agent', 'plan', 'other']);
  });

  it('backs ToolKindSchema', () => {
    expect(ToolKindSchema.options).toEqual([...TOOL_KINDS]);
    expect(ToolKindSchema.safeParse('think').success).toBe(false);
  });
});

describe('toolKindOf', () => {
  it.each([
    ['Read', 'read'],
    ['NotebookRead', 'read'],
    ['Edit', 'edit'],
    ['Write', 'edit'],
    ['MultiEdit', 'edit'],
    ['NotebookEdit', 'edit'],
    ['Bash', 'run'],
    ['BashOutput', 'run'],
    ['KillShell', 'run'],
    ['Grep', 'search'],
    ['Glob', 'search'],
    ['LS', 'search'],
    ['ToolSearch', 'search'],
    ['WebFetch', 'web'],
    ['WebSearch', 'web'],
    ['Skill', 'skill'],
    ['Agent', 'agent'],
    ['Task', 'agent'],
    ['TodoWrite', 'plan'],
    ['TaskCreate', 'plan'],
    ['TaskUpdate', 'plan'],
    ['ExitPlanMode', 'plan'],
    ['mcp__jira__search', 'other'],
    ['', 'other'],
    ['read', 'other'],
    ['constructor', 'other'],
  ])('maps %j to %s', (name, kind) => {
    expect(toolKindOf(name)).toBe(kind);
  });

  it('maps nothing to mail yet', () => {
    const names = ['Read', 'Edit', 'Bash', 'Grep', 'WebFetch', 'Skill', 'Agent', 'TodoWrite', 'Mail', 'SendMail'];
    expect(names.map(toolKindOf)).not.toContain('mail');
  });
});

describe('ACTIVITY_EVENT_NAMES matches the union', () => {
  it('names exactly the members of ActivitySpoolEventSchema', () => {
    expect(ActivitySpoolEventSchema.options.map((option) => option.shape.event.value)).toEqual([...ACTIVITY_EVENT_NAMES]);
  });
});

const AT = '2026-11-14T10:00:00.000Z';
const stepDto = {
  id: 'toolu_1', tool: 'Bash', kind: 'run', title: 'npm test', agentId: null, agentType: null,
  startedAt: AT, endedAt: null, ok: null, added: null, removed: null,
};
const detail = {
  sessionId: 'cedar:cc-meadow-hr:0.0',
  current: stepDto,
  steps: [{ ...stepDto, id: 'toolu_0', tool: 'Edit', kind: 'edit', title: 'src/a.ts', endedAt: AT, ok: true, added: 3, removed: 1 }, stepDto],
  todos: [{ id: '1', subject: 'Write the tests', status: 'completed' }, { id: null, subject: 'Ship', status: 'pending' }],
  helpers: [{ agentId: 'agent_1', agentType: 'Explore', startedAt: AT }],
  meters: { contextPct: 41.5, model: 'claude-opus-4-5', costUsd: 1.25, updatedAt: AT },
  paused: true,
  pauseHit: false,
};
const activity = { sessionId: 'cedar:cc-meadow-hr:0.0', tool: 'run', paused: false, helpers: 1, contextPct: 41, lastStepAt: AT };

describe('activity DTOs', () => {
  it('parses a full SessionDetailDTO', () => {
    expect(SessionDetailDTOSchema.parse(detail)).toEqual(detail);
  });

  it('accepts a detail with nothing yet', () => {
    const empty = { ...detail, current: null, steps: [], todos: [], helpers: [], meters: null, paused: false };
    expect(SessionDetailDTOSchema.parse(empty)).toEqual(empty);
  });

  it('accepts 40 steps and rejects 41', () => {
    const steps = (n: number) => Array.from({ length: n }, (_v, i) => ({ ...stepDto, id: `toolu_${i}` }));
    expect(SessionDetailDTOSchema.safeParse({ ...detail, steps: steps(40) }).success).toBe(true);
    expect(SessionDetailDTOSchema.safeParse({ ...detail, steps: steps(41) }).success).toBe(false);
  });

  it('rejects 21 to-do items in a detail', () => {
    const todos = Array.from({ length: 21 }, (_v, i) => ({ id: `${i}`, subject: 'x', status: 'pending' }));
    expect(SessionDetailDTOSchema.safeParse({ ...detail, todos }).success).toBe(false);
  });

  it('parses a SessionActivityDTO and accepts tool: null', () => {
    expect(SessionActivityDTOSchema.parse(activity)).toEqual(activity);
    expect(SessionActivityDTOSchema.safeParse({ ...activity, tool: null, contextPct: null, lastStepAt: null }).success).toBe(true);
  });

  it.each([
    ['contextPct 41.5', { contextPct: 41.5 }],
    ['contextPct 101', { contextPct: 101 }],
    ['helpers -1', { helpers: -1 }],
    ['helpers 1.5', { helpers: 1.5 }],
    ['tool "Bash" (a tool name, not a kind)', { tool: 'Bash' }],
  ])('SessionActivityDTOSchema rejects %s', (_label, patch) => {
    expect(SessionActivityDTOSchema.safeParse({ ...activity, ...patch }).success).toBe(false);
  });

  it('StepDTOSchema rejects kind "think" and fractional line counts', () => {
    expect(StepDTOSchema.safeParse({ ...stepDto, kind: 'think' }).success).toBe(false);
    expect(StepDTOSchema.safeParse({ ...stepDto, added: 1.5 }).success).toBe(false);
  });

  it('HelperDTOSchema, RateWindowDTOSchema and SessionMetersDTOSchema hold their shapes', () => {
    expect(HelperDTOSchema.safeParse({ agentId: 'a', agentType: null, startedAt: AT }).success).toBe(true);
    expect(RateWindowDTOSchema.parse({ usedPct: 12, resetsAt: AT })).toEqual({ usedPct: 12, resetsAt: AT });
    expect(RateWindowDTOSchema.safeParse({ usedPct: 101, resetsAt: AT }).success).toBe(false);
    expect(SessionMetersDTOSchema.safeParse({ contextPct: null, model: null, costUsd: null, updatedAt: AT }).success).toBe(true);
    expect(SessionMetersDTOSchema.safeParse({ contextPct: 100.1, model: null, costUsd: null, updatedAt: AT }).success).toBe(false);
  });

  it('ActivityListDTOSchema parses an empty list', () => {
    expect(ActivityListDTOSchema.parse({ items: [] })).toEqual({ items: [] });
    expect(ActivityListDTOSchema.parse({ items: [activity] })).toEqual({ items: [activity] });
  });
});
