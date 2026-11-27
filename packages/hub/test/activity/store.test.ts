import { describe, expect, it } from 'vitest';
import { SessionActivityDTOSchema, SessionDetailDTOSchema, type ActivitySpoolEvent, type TodoItem } from '@luady/shared';
import {
  applyActivity, currentStep, emptyActivity, endTurn, helperTypesOf, mergeTodos, sameMapView, toDetail, toMapView,
  type SessionActivity,
} from '../../src/activity/store.js';
import { meters, pausedEvent, subagent, toolEnd, toolStart } from '../sessions/spool-events.js';

const SID = 'cedar:cc-meadow-hr:0.0';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** Applies events one by one, freezing every intermediate record so any mutation throws. */
function run(events: readonly ActivitySpoolEvent[], start: SessionActivity = emptyActivity(SID), replay = false): SessionActivity {
  return events.reduce((record, event) => applyActivity(deepFreeze(record), event, replay), start);
}

function todo(id: string | null, subject: string, status: TodoItem['status'] = 'pending'): TodoItem {
  return { id, subject, status };
}

describe('steps', () => {
  it('a start and the end of the same id give one closed step with the counts', () => {
    const record = run([
      toolStart('Edit', 'src/app.ts', { toolUseId: 'toolu_1', ts: '2026-10-09T12:00:00.000Z' }),
      toolEnd('Edit', 'src/app.ts', { toolUseId: 'toolu_1', ok: true, added: 12, removed: 3, ts: '2026-10-09T12:00:02.000Z' }),
    ]);
    expect(record.steps).toEqual([{
      id: 'toolu_1', tool: 'Edit', kind: 'edit', title: 'src/app.ts', agentId: null, agentType: null,
      startedAt: '2026-10-09T12:00:00.000Z', endedAt: '2026-10-09T12:00:02.000Z', ok: true, added: 12, removed: 3,
    }]);
    expect(record.lastStepAt).toBe('2026-10-09T12:00:02.000Z');
  });

  it('an end without its start gives one closed step', () => {
    const record = run([toolEnd('Bash', 'npm test', { toolUseId: 'toolu_lost', ok: false, ts: '2026-10-09T12:00:05Z' })]);
    expect(record.steps).toHaveLength(1);
    expect(record.steps[0]).toMatchObject({
      id: 'toolu_lost', kind: 'run', startedAt: '2026-10-09T12:00:05.000Z', endedAt: '2026-10-09T12:00:05.000Z', ok: false,
    });
    expect(currentStep(record)).toBeNull();
  });

  it('a start that arrives after its end keeps the step closed', () => {
    const record = run([
      toolEnd('Read', 'a.ts', { toolUseId: 'toolu_2', ts: '2026-10-09T12:00:03.000Z' }),
      toolStart('Read', 'a.ts', { toolUseId: 'toolu_2', ts: '2026-10-09T12:00:01.000Z' }),
    ]);
    expect(record.steps).toEqual([expect.objectContaining({
      id: 'toolu_2', startedAt: '2026-10-09T12:00:01.000Z', endedAt: '2026-10-09T12:00:03.000Z', ok: true,
    })]);
    expect(currentStep(record)).toBeNull();
  });

  it('a failed call closes its step through its only after-tool event, with ok false', () => {
    const record = run([
      toolStart('Bash', 'npm test', { toolUseId: 'toolu_f' }),
      toolEnd('Bash', 'npm test', { toolUseId: 'toolu_f', ok: false }),
    ]);
    expect(record.steps).toEqual([expect.objectContaining({ id: 'toolu_f', ok: false, endedAt: '2026-10-09T12:00:00.000Z' })]);
    expect(currentStep(record)).toBeNull();
  });

  it('a step without a tool_use_id uses the event id', () => {
    const event = toolStart('Grep', '"TODO"');
    expect(run([event]).steps[0]?.id).toBe(event.id);
  });

  it('keeps the newest 40 steps: 45 starts drop the first five ids', () => {
    const starts = Array.from({ length: 45 }, (_, i) => toolStart('Read', `file-${i}`, { toolUseId: `toolu_${i}` }));
    const record = run(starts);
    expect(record.steps).toHaveLength(40);
    expect(record.steps.map((step) => step.id)).not.toContain('toolu_4');
    expect(record.steps[0]?.id).toBe('toolu_5');
    expect(record.steps[39]?.id).toBe('toolu_44');
  });

  it('currentStep prefers the main thread over a helper and is null when everything is closed', () => {
    const record = run([
      toolStart('Bash', 'npm test', { toolUseId: 'main' }),
      toolStart('Read', 'x.ts', { toolUseId: 'helper', agentId: 'agent-1' }),
    ]);
    expect(currentStep(record)?.id).toBe('main');
    const mainDone = run([toolEnd('Bash', 'npm test', { toolUseId: 'main' })], record);
    expect(currentStep(mainDone)?.id).toBe('helper');
    const allDone = run([toolEnd('Read', 'x.ts', { toolUseId: 'helper', agentId: 'agent-1' })], mainDone);
    expect(currentStep(allDone)).toBeNull();
  });
});

describe('helpers', () => {
  it('two subagent_start with one id give one helper and subagent_stop removes it', () => {
    const started = run([subagent('start', 'agent-1'), subagent('start', 'agent-1')]);
    expect(started.helpers).toEqual([{ agentId: 'agent-1', agentType: 'general-purpose', startedAt: '2026-10-09T12:00:00.000Z' }]);
    expect(run([subagent('stop', 'agent-1')], started).helpers).toEqual([]);
  });

  it('a stop for an unknown helper (empty agent type, no start) leaves the record as it was', () => {
    const record = deepFreeze(run([subagent('start', 'agent-1')]));
    expect(applyActivity(record, subagent('stop', 'agent-9'), false)).toBe(record);
    const bare = subagent('stop', 'agent-9');
    const untyped = { ...bare, data: { agent_id: 'agent-9', agent_type: '' } } as ActivitySpoolEvent;
    expect(applyActivity(record, untyped, false)).toBe(record);
  });

  it("a helper's own stop closes its open steps", () => {
    const record = run([
      subagent('start', 'agent-1'),
      toolStart('Read', 'x.ts', { toolUseId: 'h1', agentId: 'agent-1' }),
      toolStart('Bash', 'npm test', { toolUseId: 'main' }),
      subagent('stop', 'agent-1', { ts: '2026-10-09T12:00:30Z' }),
    ]);
    expect(record.helpers).toEqual([]);
    expect(record.steps.find((step) => step.id === 'h1')?.endedAt).toBe('2026-10-09T12:00:30.000Z');
    expect(record.steps.find((step) => step.id === 'main')?.endedAt).toBeNull();
  });
});

describe('to-dos', () => {
  const LIST = [todo('1', 'Write tests'), todo('2', 'Implement'), todo('3', 'Review'), todo('4', 'Ship')];

  it('replace then merge of one item by id changes only its status and keeps the subject for an empty one', () => {
    const replaced = run([toolEnd('TodoWrite', 'plan', { todos: LIST, todoMode: 'replace' })]);
    expect(replaced.todos).toEqual(LIST);
    const merged = run([toolEnd('TaskUpdate', '#2', { todos: [todo('2', '', 'completed')], todoMode: 'merge' })], replaced);
    expect(merged.todos).toEqual([LIST[0], todo('2', 'Implement', 'completed'), LIST[2], LIST[3]]);
  });

  it('a step without any to-do list leaves the list empty (the normal case)', () => {
    const record = run([toolStart('Bash', 'x', { toolUseId: 'a' }), toolEnd('Bash', 'x', { toolUseId: 'a' })]);
    expect(record.todos).toEqual([]);
  });

  it('defaults to replace when the mode is missing', () => {
    const record = run([toolEnd('TodoWrite', 'plan', { todos: LIST }), toolEnd('TodoWrite', 'plan', { todos: [todo('9', 'Only')] })]);
    expect(record.todos).toEqual([todo('9', 'Only')]);
  });

  it('a merged item with an unknown id, or without an id, is appended', () => {
    expect(mergeTodos(LIST, [todo('7', 'New one')], 'merge')).toEqual([...LIST, todo('7', 'New one')]);
    expect(mergeTodos(LIST, [todo(null, 'No id')], 'merge')).toEqual([...LIST, todo(null, 'No id')]);
  });

  it('a 21st item pushes out the oldest completed one, else the oldest', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => todo(String(i), `item ${i}`, i === 5 || i === 9 ? 'completed' : 'pending'));
    const withNew = mergeTodos(twenty, [todo('new', 'item new')], 'merge');
    expect(withNew).toHaveLength(20);
    expect(withNew.map((item) => item.id)).not.toContain('5');
    expect(withNew.map((item) => item.id)).toContain('9');
    expect(withNew.at(-1)?.id).toBe('new');
    const open = Array.from({ length: 20 }, (_, i) => todo(String(i), `item ${i}`));
    expect(mergeTodos(open, [todo('new', 'x')], 'merge').map((item) => item.id)[0]).toBe('1');
  });

  it('replace keeps at most 20 items', () => {
    const many = Array.from({ length: 20 }, (_, i) => todo(String(i), `item ${i}`));
    expect(mergeTodos([], [...many, todo('x', 'extra')], 'replace')).toEqual(many);
  });
});

describe('meters, pause and replay', () => {
  it('meters set the record and toMapView rounds 41.6 to 42', () => {
    const record = run([meters({ context_pct: 41.6, model: 'claude-opus-4-1', cost_usd: 1.25 }, { ts: '2026-10-09T12:01:00Z' })]);
    expect(record.meters).toEqual({ contextPct: 41.6, model: 'claude-opus-4-1', costUsd: 1.25, updatedAt: '2026-10-09T12:01:00.000Z' });
    expect(toMapView(record, false).contextPct).toBe(42);
    expect(toMapView(run([meters({ context_pct: null })]), false).contextPct).toBeNull();
  });

  it('a replayed tool_start leaves the record identical while a replayed meters applies', () => {
    const prev = deepFreeze(emptyActivity(SID));
    expect(applyActivity(prev, toolStart('Bash', 'old run'), true)).toBe(prev);
    expect(applyActivity(prev, toolEnd('Bash', 'old run'), true)).toBe(prev);
    expect(applyActivity(prev, subagent('start', 'agent-1'), true)).toBe(prev);
    expect(applyActivity(prev, meters({ context_pct: 10 }), true).meters?.contextPct).toBe(10);
    expect(applyActivity(prev, pausedEvent(), true).pauseHitAt).toBe('2026-10-09T12:00:00.000Z');
  });

  it('paused records when the pause hit', () => {
    expect(emptyActivity(SID).pauseHitAt).toBeNull();
    expect(run([pausedEvent({ ts: '2026-10-09T12:01:00Z' })]).pauseHitAt).toBe('2026-10-09T12:01:00.000Z');
    expect(toDetail(run([pausedEvent()]), true).pauseHit).toBe(true);
  });

  it('a step that started after the hit proves the session runs again: the hit is cleared', () => {
    const hit = run([toolStart('Bash', 'x', { toolUseId: 'a', ts: '2026-10-09T12:00:00Z' }), pausedEvent({ ts: '2026-10-09T12:01:00Z' })]);
    expect(hit.pauseHitAt).toBe('2026-10-09T12:01:00.000Z');
    expect(run([toolStart('Read', 'y', { toolUseId: 'b', ts: '2026-10-09T12:01:05Z' })], hit).pauseHitAt).toBeNull();
    const started = run([toolStart('Read', 'y', { toolUseId: 'b', ts: '2026-10-09T12:01:05Z' })], hit);
    const ended = run([toolEnd('Read', 'y', { toolUseId: 'b', ts: '2026-10-09T12:01:06Z' })], { ...started, pauseHitAt: '2026-10-09T12:01:00.000Z' });
    expect(ended.pauseHitAt).toBeNull();
  });

  it('the end of the tool that ran at the hit, an older or replayed older step, or an end without its start leave the hit', () => {
    const hit = deepFreeze(run([toolStart('Bash', 'x', { toolUseId: 'a', ts: '2026-10-09T12:00:00Z' }), pausedEvent({ ts: '2026-10-09T12:01:00Z' })]));
    const kept = (event: ActivitySpoolEvent, replay = false): string | null => applyActivity(hit, event, replay).pauseHitAt;
    expect(kept(toolEnd('Bash', 'x', { toolUseId: 'a', ok: false, ts: '2026-10-09T12:01:02Z' }))).toBe('2026-10-09T12:01:00.000Z');
    expect(kept(toolStart('Read', 'old', { toolUseId: 'c', ts: '2026-10-09T12:00:30Z' }))).toBe('2026-10-09T12:01:00.000Z');
    expect(kept(toolStart('Read', 'old', { toolUseId: 'c', ts: '2026-10-09T11:40:00Z' }), true)).toBe('2026-10-09T12:01:00.000Z');
    expect(kept(toolEnd('Read', 'lost', { toolUseId: 'unknown', ts: '2026-10-09T12:05:00Z' }))).toBe('2026-10-09T12:01:00.000Z');
  });

  it('a replayed step newer than the hit still clears it', () => {
    const hit = run([pausedEvent({ ts: '2026-10-09T11:00:00Z' })]);
    expect(applyActivity(hit, toolStart('Read', 'y', { toolUseId: 'b', ts: '2026-10-09T11:05:00Z' }), true).pauseHitAt).toBeNull();
  });

  it('a replayed end closes a step that is open, and a replayed helper stop removes a running helper', () => {
    const open = run([
      subagent('start', 'agent-1'),
      toolStart('Read', 'x.ts', { toolUseId: 'h1', agentId: 'agent-1' }),
      toolStart('Bash', 'npm test', { toolUseId: 'main' }),
    ]);
    const ended = run([toolEnd('Bash', 'npm test', { toolUseId: 'main', ok: false, ts: '2026-10-09T12:20:00Z' })], open, true);
    expect(ended.steps.find((step) => step.id === 'main')).toMatchObject({ endedAt: '2026-10-09T12:20:00.000Z', ok: false });
    const stopped = run([subagent('stop', 'agent-1', { ts: '2026-10-09T12:21:00Z' })], ended, true);
    expect(stopped.helpers).toEqual([]);
    expect(stopped.steps.find((step) => step.id === 'h1')?.endedAt).toBe('2026-10-09T12:21:00.000Z');
    expect(currentStep(stopped)).toBeNull();
  });

  it('a replayed line never opens anything: an end of an unknown id, a start, a helper start', () => {
    const prev = deepFreeze(run([toolStart('Read', 'a', { toolUseId: 'a' })]));
    expect(applyActivity(prev, toolEnd('Bash', 'old', { toolUseId: 'unknown' }), true)).toBe(prev);
    expect(applyActivity(prev, toolEnd('Bash', 'old', { toolUseId: 'unknown', todos: [todo('1', 'x')] }), true)).toBe(prev);
    expect(applyActivity(prev, toolStart('Bash', 'old', { toolUseId: 'b' }), true)).toBe(prev);
    expect(applyActivity(prev, subagent('start', 'agent-9'), true)).toBe(prev);
  });

  it('the pause hit drops the helpers and closes every open step (a stopped session runs nothing)', () => {
    const record = run([
      subagent('start', 'agent-1'),
      toolStart('Read', 'x.ts', { toolUseId: 'h1', agentId: 'agent-1' }),
      toolStart('Grep', 'y', { toolUseId: 'main' }),
      pausedEvent({ ts: '2026-10-09T12:02:00Z' }),
    ]);
    expect(record.helpers).toEqual([]);
    expect(record.steps.every((step) => step.endedAt === '2026-10-09T12:02:00.000Z')).toBe(true);
    expect(toMapView(record, true)).toMatchObject({ tool: null, helpers: 0 });
    expect(run([pausedEvent({ ts: '2026-10-09T12:30:00Z' })], deepFreeze(record), true).helpers).toEqual([]);
  });
});

describe('endTurn', () => {
  it("closes the main thread's open steps and those of a lost helper, and clears pauseHit", () => {
    const record = run([
      pausedEvent(),
      toolStart('Bash', 'npm test', { toolUseId: 'a' }),
      toolStart('Read', 'b.ts', { toolUseId: 'b', agentId: 'agent-lost' }),
      toolStart('Grep', 'x', { toolUseId: 'c' }),
      toolEnd('Grep', 'x', { toolUseId: 'c' }),
    ]);
    const ended = endTurn(deepFreeze(record), '2026-10-09T12:05:00.000Z');
    expect(ended.steps.filter((step) => step.endedAt === '2026-10-09T12:05:00.000Z').map((step) => step.id)).toEqual(['a', 'b']);
    expect(ended.steps.find((step) => step.id === 'a')?.ok).toBeNull();
    expect(ended.steps.find((step) => step.id === 'c')?.endedAt).toBe('2026-10-09T12:00:00.000Z');
    expect(ended.pauseHitAt).toBeNull();
    expect(currentStep(ended)).toBeNull();
  });

  it('keeps background helpers and their running steps across a Stop', () => {
    const record = run([
      subagent('start', 'agent-1'),
      toolStart('Read', 'b.ts', { toolUseId: 'b', agentId: 'agent-1' }),
      toolStart('Bash', 'npm test', { toolUseId: 'a' }),
    ]);
    const ended = endTurn(deepFreeze(record), '2026-10-09T12:05:00.000Z');
    expect(ended.helpers.map((helper) => helper.agentId)).toEqual(['agent-1']);
    expect(ended.steps.find((step) => step.id === 'b')?.endedAt).toBeNull();
    expect(ended.steps.find((step) => step.id === 'a')?.endedAt).toBe('2026-10-09T12:05:00.000Z');
    expect(currentStep(ended)?.id).toBe('b');
    const done = run([subagent('stop', 'agent-1', { ts: '2026-10-09T12:06:00Z' })], ended);
    expect(done.helpers).toEqual([]);
    expect(currentStep(done)).toBeNull();
  });

  it('expires helpers that had no step since the turn started, and keeps those that did', () => {
    const record = run([
      subagent('start', 'old', { ts: '2026-10-09T11:00:00Z' }),
      toolStart('Read', 'a', { toolUseId: 'o1', agentId: 'old', ts: '2026-10-09T11:01:00Z' }),
      subagent('start', 'busy', { ts: '2026-10-09T11:00:00Z' }),
      toolStart('Read', 'b', { toolUseId: 'b1', agentId: 'busy', ts: '2026-10-09T12:03:00Z' }),
    ]);
    const ended = endTurn(deepFreeze(record), '2026-10-09T12:05:00.000Z', '2026-10-09T12:00:00.000Z');
    expect(ended.helpers.map((helper) => helper.agentId)).toEqual(['busy']);
    expect(ended.steps.find((step) => step.id === 'o1')?.endedAt).toBe('2026-10-09T12:05:00.000Z');
    expect(ended.steps.find((step) => step.id === 'b1')?.endedAt).toBeNull();
    expect(endTurn(deepFreeze(record), '2026-10-09T12:05:00.000Z').helpers).toHaveLength(2);
  });

  it('returns the same record when there is nothing to close', () => {
    const record = deepFreeze(run([toolStart('Read', 'a', { toolUseId: 'a' }), toolEnd('Read', 'a', { toolUseId: 'a' })]));
    expect(endTurn(record, '2026-10-09T12:05:00.000Z')).toBe(record);
  });
});

describe('views', () => {
  it('toMapView and toDetail match the shared schemas', () => {
    const record = run([toolStart('Bash', 'npm test', { toolUseId: 'a', ts: '2026-10-09T12:00:09Z' }), subagent('start', 'agent-1')]);
    const view = toMapView(record, true);
    expect(SessionActivityDTOSchema.parse(view)).toEqual({
      sessionId: SID, tool: 'run', paused: true, helpers: 1, contextPct: null, lastStepAt: '2026-10-09T12:00:09.000Z',
      title: 'npm test', helperTypes: ['general-purpose'], turnStartedAt: null,
    });
    expect(toMapView(record, false, '2026-10-09T12:00:00.000Z').turnStartedAt).toBe('2026-10-09T12:00:00.000Z');
    const detail = toDetail(record, true);
    expect(SessionDetailDTOSchema.parse(detail)).toEqual(detail);
    expect(detail).toMatchObject({ sessionId: SID, current: { id: 'a' }, paused: true, pauseHit: false, meters: null });
  });

  it('sameMapView is false when the tool, the step title or the pause differs', () => {
    const reading = run([toolStart('Read', 'a.ts', { toolUseId: 'a' })]);
    const otherTitle = run([toolStart('Read', 'b.ts', { toolUseId: 'a' })]);
    const editing = run([toolStart('Edit', 'a.ts', { toolUseId: 'a' })]);
    expect(sameMapView(toMapView(reading, false), toMapView(otherTitle, false))).toBe(false);
    expect(sameMapView(toMapView(reading, false), toMapView(reading, false))).toBe(true);
    expect(sameMapView(toMapView(reading, false, null), toMapView(reading, false, '2026-10-09T12:00:00.000Z'))).toBe(false);
    expect(sameMapView(toMapView(reading, false), toMapView(editing, false))).toBe(false);
    expect(sameMapView(toMapView(reading, false), toMapView(reading, true))).toBe(false);
  });
});

describe('helper types', () => {
  it('lists up to three distinct helper types in start order, untyped ones as general', () => {
    const helpers = [
      { agentId: 'a', agentType: 'Explore', startedAt: 'x' }, { agentId: 'b', agentType: 'Explore', startedAt: 'x' },
      { agentId: 'c', agentType: null, startedAt: 'x' }, { agentId: 'd', agentType: 'Plan', startedAt: 'x' },
      { agentId: 'e', agentType: 'code-reviewer', startedAt: 'x' },
    ];
    expect(helperTypesOf(helpers)).toEqual(['Explore', 'general', 'Plan']);
    expect(helperTypesOf([])).toEqual([]);
  });
});
