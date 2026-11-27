import { describe, expect, it } from 'vitest';
import { IDLE_SLEEP_MS, SILENT_WARN_MS, toolKind, visualFor, type ToolKind, type Visual, type VisualInput } from '../src/visuals.js';

const base: VisualInput = { state: 'idle', idleMs: 0, silentMs: 0 };
const v = (pose: Visual['pose'], bubble: Visual['bubble'], monitor: Visual['monitor'], needsOwner = false): Visual => ({ pose, bubble, monitor, needsOwner });

describe('thresholds', () => {
  it('sleeps after 5 minutes and warns after 10 minutes of silence', () => {
    expect(IDLE_SLEEP_MS).toBe(300_000);
    expect(SILENT_WARN_MS).toBe(600_000);
  });
});

describe('visualFor', () => {
  const rows: readonly (readonly [string, Partial<VisualInput>, Visual])[] = [
    ['starting walks in', { state: 'starting' }, v('walk', null, 'off')],
    ['working with no tool thinks', { state: 'working' }, v('type', 'dots', 'work')],
    ['working with a null tool thinks', { state: 'working', tool: null }, v('type', 'dots', 'work')],
    ['working read', { state: 'working', tool: 'read' }, v('type', 'book', 'work')],
    ['working edit', { state: 'working', tool: 'edit' }, v('type', 'pencil', 'work')],
    ['working run', { state: 'working', tool: 'run' }, v('type', 'term', 'work')],
    ['working search', { state: 'working', tool: 'search' }, v('type', 'search', 'work')],
    ['working web', { state: 'working', tool: 'web' }, v('type', 'globe', 'work')],
    ['working skill', { state: 'working', tool: 'skill' }, v('type', 'skill', 'work')],
    ['working mail', { state: 'working', tool: 'mail' }, v('type', 'mail', 'work')],
    ['working agent (helpers)', { state: 'working', tool: 'agent' }, v('type', 'team', 'work')],
    ['working plan', { state: 'working', tool: 'plan' }, v('type', 'list', 'work')],
    ['working other (an MCP tool)', { state: 'working', tool: 'other' }, v('type', 'gear', 'work')],
    ['working with a tool kind from a newer hub', { state: 'working', tool: 'teleport' as ToolKind }, v('type', 'dots', 'work')],
    ['working just under the silence limit', { state: 'working', tool: 'edit', silentMs: SILENT_WARN_MS - 1 }, v('type', 'pencil', 'work')],
    ['working silent for exactly the limit', { state: 'working', tool: 'edit', silentMs: SILENT_WARN_MS }, v('type', 'ask', 'work')],
    ['idle sits', { state: 'idle' }, v('sit', null, 'off')],
    ['idle just under the sleep limit', { state: 'idle', idleMs: IDLE_SLEEP_MS - 1 }, v('sit', null, 'off')],
    ['idle for exactly the sleep limit', { state: 'idle', idleMs: IDLE_SLEEP_MS }, v('sleep', 'zzz', 'off')],
    ['waiting_question', { state: 'waiting_question' }, v('alert', 'bang', 'alert', true)],
    ['waiting_permission', { state: 'waiting_permission' }, v('alert', 'key', 'alert', true)],
    ['error', { state: 'error' }, v('down', 'cross', 'error')],
    ['ended', { state: 'ended' }, v('gone', null, 'off')],
    ['paused while working', { state: 'working', tool: 'edit', paused: true }, v('sit', 'pause', 'off')],
    ['paused while working silently', { state: 'working', silentMs: SILENT_WARN_MS, paused: true }, v('sit', 'pause', 'off')],
    ['paused while idle', { state: 'idle', idleMs: IDLE_SLEEP_MS, paused: true }, v('sit', 'pause', 'off')],
    ['paused does not hide a question', { state: 'waiting_question', paused: true }, v('alert', 'bang', 'alert', true)],
    ['paused false changes nothing', { state: 'working', tool: 'read', paused: false }, v('type', 'book', 'work')],
    ['unknown state from a newer hub', { state: 'compacting' }, v('sit', 'dots', 'off')],
    ['empty state', { state: '' }, v('sit', 'dots', 'off')],
    ['state named like an object key', { state: 'constructor' }, v('sit', 'dots', 'off')],
  ];

  it.each(rows)('%s', (_name, input, expected) => {
    expect(visualFor({ ...base, ...input })).toEqual(expected);
  });

  it('returns frozen values', () => {
    expect(Object.isFrozen(visualFor({ ...base, state: 'working', tool: 'run' }))).toBe(true);
    expect(Object.isFrozen(visualFor({ ...base, state: 'weird' }))).toBe(true);
  });
});

describe('toolKind', () => {
  const rows: readonly (readonly [string, ToolKind])[] = [
    ['Read', 'read'], ['NotebookRead', 'read'],
    ['Edit', 'edit'], ['Write', 'edit'], ['MultiEdit', 'edit'], ['NotebookEdit', 'edit'],
    ['Bash', 'run'], ['BashOutput', 'run'], ['KillShell', 'run'],
    ['Grep', 'search'], ['Glob', 'search'], ['LS', 'search'], ['ToolSearch', 'search'],
    ['WebFetch', 'web'], ['WebSearch', 'web'],
    ['Skill', 'skill'],
    ['Agent', 'agent'], ['Task', 'agent'],
    ['TodoWrite', 'plan'], ['TaskCreate', 'plan'], ['TaskUpdate', 'plan'], ['ExitPlanMode', 'plan'],
    ['mcp__jira__search', 'other'], ['', 'other'], ['read', 'other'], ['Teleport', 'other'], ['constructor', 'other'], ['__proto__', 'other'],
  ];

  it.each(rows)('%s → %s', (name, kind) => {
    expect(toolKind(name)).toBe(kind);
  });
});
