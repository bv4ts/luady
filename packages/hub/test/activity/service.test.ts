import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostId, SessionActivityDTO, SessionDTO } from '@luady/shared';
import { ACTIVITY_BROADCAST_MS, STEPS_FLUSH_MS, createActivityService, type ActivityService } from '../../src/activity/service.js';
import { createBus } from '../../src/core/bus.js';
import type { HubEvents } from '../../src/core/contracts.js';
import { createFakeClock, silentLogger } from '../helpers/fakes.js';
import { meters, pausedEvent, subagent, toolEnd, toolStart } from '../sessions/spool-events.js';

const A = 'cedar:cc-meadow-hr:0.0';
const B = 'cedar:cc-api:0.0';
const C = 'birch:cc-orchard:0.0';
const BRAIN = 'hq:manager:0.0';
const TARGETS: Record<string, { host: HostId; tmux: string }> = {
  [A]: { host: 'cedar', tmux: 'cc-meadow-hr:0.0' },
  [B]: { host: 'cedar', tmux: 'cc-api:0.0' },
  [C]: { host: 'birch', tmux: 'cc-orchard:0.0' },
  [BRAIN]: { host: 'hq', tmux: 'manager:0.0' },
};

function stubPauses() {
  let paused: ReadonlySet<string> = new Set();
  let listeners: ReadonlyArray<(id: string) => void> = [];
  return {
    markHit: vi.fn((_id: string) => undefined),
    clearHit: vi.fn((_id: string) => undefined),
    isPaused: (id: string) => paused.has(id),
    list: () => [...paused],
    onChange(listener: (id: string) => void) {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((item) => item !== listener);
      };
    },
    set(id: string, on: boolean) {
      paused = on ? new Set([...paused, id]) : new Set([...paused].filter((item) => item !== id));
      for (const listener of listeners) listener(id);
    },
  };
}

function session(id: string, state: SessionDTO['state']): SessionDTO {
  const { host, tmux } = TARGETS[id] ?? { host: 'cedar' as const, tmux: 'cc-x:0.0' };
  return {
    id, host, target: tmux, claudeSessionId: 'c-1', cwd: null, project: null, displayName: tmux, state,
    origin: host === 'hq' ? 'system' : 'owner', registered: true, lastEventAt: null, turnStartedAt: null,
    pendingQid: null, unexpectedEnd: false,
  };
}

let service: ActivityService;

function setup() {
  const bus = createBus();
  const pauses = stubPauses();
  const updates: SessionActivityDTO[][] = [];
  const streams: Array<HubEvents['steps.appended']> = [];
  const meterEvents: Array<HubEvents['meters.updated']> = [];
  /** Sessions the registry holds as ended or does not know. */
  const gone = new Set<string>();
  const isLive = vi.fn((id: string) => !gone.has(id));
  bus.on('activity.updated', ({ items }) => updates.push(items));
  bus.on('steps.appended', (payload) => streams.push(payload));
  bus.on('meters.updated', (payload) => meterEvents.push(payload));
  service = createActivityService({
    bus, clock: createFakeClock('2026-10-09T12:05:00.000Z'), log: silentLogger(), pauses, isSystem: (id) => id.startsWith('hq:'), isLive,
  });
  service.start();
  const on = (id: string) => ({ host: TARGETS[id]?.host ?? 'cedar', tmux: TARGETS[id]?.tmux ?? null });
  const start = (id: string, tool: string, title: string, toolUseId: string, over: Record<string, unknown> = {}): void =>
    service.accept(on(id).host, toolStart(tool, title, { tmux: on(id).tmux, toolUseId, ...over }), false);
  const end = (id: string, tool: string, title: string, toolUseId: string, over: Record<string, unknown> = {}): void =>
    service.accept(on(id).host, toolEnd(tool, title, { tmux: on(id).tmux, toolUseId, ...over }), false);
  return { bus, pauses, updates, streams, meterEvents, start, end, on, gone, isLive };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  service.stop();
  vi.useRealTimers();
});

describe('the map coalescer', () => {
  it('sends the first change at once and holds a burst until the second is over', async () => {
    const t = setup();
    t.start(A, 'Bash', 'npm test', 'a-0');
    expect(t.updates).toEqual([[expect.objectContaining({ sessionId: A, tool: 'run', paused: false, helpers: 0 })]]);
    for (let i = 1; i <= 50; i += 1) {
      for (const id of [A, B, C]) {
        t.start(id, 'Read', `file ${i}`, `${id}-${i}`);
        t.end(id, 'Read', `file ${i}`, `${id}-${i}`);
      }
      if (i === 25) t.end(A, 'Bash', 'npm test', 'a-0');
      await vi.advanceTimersByTimeAsync(18);
    }
    expect(t.updates).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(ACTIVITY_BROADCAST_MS - 900);
    expect(t.updates).toHaveLength(2);
    expect(t.updates[1]?.map((view) => [view.sessionId, view.tool])).toEqual([[A, null], [B, null], [C, null]]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.updates).toHaveLength(2);
  });

  it('never sends more than one activity.updated a second in a long burst of 14 sessions, and ends on the final state', async () => {
    const t = setup();
    const ids = Array.from({ length: 14 }, (_, i) => `cedar:cc-s${i}:0.0`);
    const times: number[] = [];
    t.bus.on('activity.updated', () => times.push(Date.now()));
    for (let tick = 0; tick < 100; tick += 1) {
      const ts = new Date().toISOString();
      for (const id of ids) {
        const tmux = id.slice('cedar:'.length);
        service.accept('cedar', toolStart('Bash', `run ${tick}`, { tmux, ts, toolUseId: `${id}-${tick}` }), false);
        service.accept('cedar', toolEnd('Bash', `run ${tick}`, { tmux, ts, toolUseId: `${id}-${tick}` }), false);
      }
      service.accept('cedar', toolStart('Edit', 'last', { tmux: 'cc-s3:0.0', ts, toolUseId: `last-${tick}` }), false);
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(3_000);
    const gaps = times.slice(1).map((at, i) => at - (times[i] ?? 0));
    expect(times.length).toBeGreaterThanOrEqual(5);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(ACTIVITY_BROADCAST_MS);
    expect(t.updates.at(-1)).toHaveLength(14);
    const final = new Map(t.updates.flat().map((view) => [view.sessionId, view]));
    expect(final.get('cedar:cc-s3:0.0')?.tool).toBe('edit');
    expect(final.get('cedar:cc-s0:0.0')?.tool).toBeNull();
    expect(service.snapshot().find((view) => view.sessionId === 'cedar:cc-s3:0.0')?.tool).toBe('edit');
  });

  it('sends nothing when the map view does not change, and the new title when the step title changes', async () => {
    const t = setup();
    t.start(A, 'Read', 'a.ts', 'a-1');
    await vi.advanceTimersByTimeAsync(2_000);
    t.start(A, 'Read', 'a.ts', 'a-1');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates).toHaveLength(1);
    t.start(A, 'Read', 'b.ts', 'a-1');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates).toHaveLength(2);
    expect(t.updates.at(-1)?.[0]).toMatchObject({ sessionId: A, tool: 'read', title: 'b.ts' });
  });

  it('meters: 41 → 41.4 sends no activity.updated but a meters.updated; 41 → 42 sends both', async () => {
    const t = setup();
    const at = (pct: number) => meters({ context_pct: pct }, { tmux: 'cc-meadow-hr:0.0' });
    service.accept('cedar', at(41), false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates.map((items) => items[0]?.contextPct)).toEqual([41]);
    service.accept('cedar', at(41.4), false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates).toHaveLength(1);
    expect(t.meterEvents).toHaveLength(2);
    service.accept('cedar', at(42), false);
    expect(t.updates.map((items) => items[0]?.contextPct)).toEqual([41, 42]);
    expect(t.meterEvents).toHaveLength(3);
  });

  it('a meters event without a pane emits only meters.updated, with the windows converted', () => {
    const t = setup();
    service.accept('birch', meters({
      five_hour: { used_pct: 62.5, resets_at: '2026-10-09T15:00:00+04:00' }, seven_day: null,
    }, { tmux: null, ts: '2026-10-09T12:04:00Z' }), false);
    expect(t.meterEvents).toEqual([{
      host: 'birch', sessionId: null, fiveHour: { usedPct: 62.5, resetsAt: '2026-10-09T11:00:00.000Z' }, sevenDay: null,
      at: '2026-10-09T12:04:00.000Z',
    }]);
    expect(t.updates).toEqual([]);
    expect(service.snapshot()).toEqual([]);
  });

  it('a step of a system session never reaches the map', async () => {
    const t = setup();
    t.start(BRAIN, 'Bash', 'luady tools', 'brain-1');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates).toEqual([]);
    expect(service.snapshot()).toEqual([]);
  });

  it('replayed lines close what is open and never open anything', async () => {
    const t = setup();
    service.accept('cedar', toolStart('Bash', 'old', { tmux: 'cc-meadow-hr:0.0' }), true);
    service.accept('cedar', subagent('start', 'agent-old', { tmux: 'cc-meadow-hr:0.0' }), true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates).toEqual([]);
    expect(service.snapshot()).toEqual([]);
    t.start(A, 'Bash', 'npm test', 'a-1');
    service.accept('cedar', subagent('start', 'agent-1', { tmux: 'cc-meadow-hr:0.0' }), false);
    await vi.advanceTimersByTimeAsync(2_000);
    service.accept('cedar', toolEnd('Bash', 'npm test', { tmux: 'cc-meadow-hr:0.0', toolUseId: 'a-1' }), true);
    service.accept('cedar', subagent('stop', 'agent-1', { tmux: 'cc-meadow-hr:0.0' }), true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(service.snapshot()).toEqual([expect.objectContaining({ sessionId: A, tool: null, helpers: 0 })]);
  });

  it('a turn end expires a helper that had no step since the turn began', async () => {
    const t = setup();
    service.accept('cedar', subagent('start', 'agent-1', { tmux: 'cc-meadow-hr:0.0', ts: '2026-10-09T11:00:00Z' }), false);
    t.bus.emit('session.updated', { ...session(A, 'working'), turnStartedAt: '2026-10-09T12:00:00.000Z' });
    t.start(A, 'Read', 'a.ts', 'm-1', { ts: '2026-10-09T12:01:00Z' });
    t.end(A, 'Read', 'a.ts', 'm-1', { ts: '2026-10-09T12:01:00Z' });
    expect(service.snapshot()[0]?.helpers).toBe(1);
    t.bus.emit('session.updated', session(A, 'idle'));
    expect(service.snapshot()[0]?.helpers).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates.flat().at(-1)).toMatchObject({ sessionId: A, helpers: 0 });
  });
});

describe('the step stream', () => {
  it('emits nothing for a session nobody watches', async () => {
    const t = setup();
    t.start(A, 'Bash', 'npm test', 'a-1');
    t.end(A, 'Bash', 'npm test', 'a-1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.streams).toEqual([]);
  });

  it('collects 250 ms of changes into one steps.appended with each step once in its latest form', async () => {
    const t = setup();
    service.watch(A);
    t.start(A, 'Bash', 'npm test', 'a-1');
    t.start(A, 'Read', 'a.ts', 'a-2');
    t.end(A, 'Bash', 'npm test', 'a-1', { ok: false });
    await vi.advanceTimersByTimeAsync(STEPS_FLUSH_MS - 1);
    expect(t.streams).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.streams).toHaveLength(1);
    expect(t.streams[0]).toMatchObject({ sessionId: A, todos: null, helpers: null });
    expect(t.streams[0]?.steps.map((step) => [step.id, step.ok, step.endedAt === null])).toEqual([['a-1', false, false], ['a-2', null, true]]);
  });

  it('includes to-dos and helpers only when they changed in that window', async () => {
    const t = setup();
    service.watch(A);
    t.end(A, 'TodoWrite', 'plan', 'a-1', { todos: [{ id: '1', subject: 'Write tests', status: 'pending' }] });
    service.accept('cedar', subagent('start', 'agent-1', { tmux: 'cc-meadow-hr:0.0' }), false);
    await vi.advanceTimersByTimeAsync(STEPS_FLUSH_MS);
    expect(t.streams[0]?.todos).toEqual([{ id: '1', subject: 'Write tests', status: 'pending' }]);
    expect(t.streams[0]?.helpers).toEqual([expect.objectContaining({ agentId: 'agent-1' })]);
    t.start(A, 'Read', 'x', 'a-2');
    await vi.advanceTimersByTimeAsync(STEPS_FLUSH_MS);
    expect(t.streams[1]).toMatchObject({ todos: null, helpers: null });
  });

  it('two watches need two unwatches; unwatch stops the stream', async () => {
    const t = setup();
    service.watch(A);
    service.watch(A);
    service.unwatch(A);
    t.start(A, 'Bash', 'npm test', 'a-1');
    await vi.advanceTimersByTimeAsync(STEPS_FLUSH_MS);
    expect(t.streams).toHaveLength(1);
    service.unwatch(A);
    t.end(A, 'Bash', 'npm test', 'a-1');
    await vi.advanceTimersByTimeAsync(STEPS_FLUSH_MS);
    expect(t.streams).toHaveLength(1);
  });
});

describe('turn and life cycle', () => {
  it('a session that went idle loses its tool', async () => {
    const t = setup();
    t.start(A, 'Bash', 'npm test', 'a-1');
    await vi.advanceTimersByTimeAsync(2_000);
    t.bus.emit('session.updated', session(A, 'working'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates).toHaveLength(1);
    t.bus.emit('session.updated', session(A, 'idle'));
    expect(t.updates).toHaveLength(2);
    expect(t.updates[1]).toEqual([expect.objectContaining({ sessionId: A, tool: null })]);
    expect(service.detail(A).steps[0]?.endedAt).toBe('2026-10-09T12:05:00.000Z');
  });

  it('a step whose end never comes is closed when the turn ends (a lost pair never stays running)', async () => {
    const t = setup();
    service.watch(A);
    t.start(A, 'Bash', 'npm test', 'a-1');
    await vi.advanceTimersByTimeAsync(2_000);
    t.bus.emit('session.updated', session(A, 'error'));
    expect(service.detail(A).current).toBeNull();
    await vi.advanceTimersByTimeAsync(STEPS_FLUSH_MS);
    expect(t.streams.at(-1)).toMatchObject({ helpers: null, steps: [expect.objectContaining({ id: 'a-1', ok: null })] });
  });

  it('a Stop while a background helper runs keeps the helper on the map until its own stop', async () => {
    const t = setup();
    service.accept('cedar', subagent('start', 'agent-1', { tmux: 'cc-meadow-hr:0.0' }), false);
    t.start(A, 'Read', 'x.ts', 'h-1', { agentId: 'agent-1' });
    await vi.advanceTimersByTimeAsync(2_000);
    t.bus.emit('session.updated', session(A, 'idle'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(service.snapshot()).toEqual([expect.objectContaining({ sessionId: A, helpers: 1, tool: 'read' })]);
    service.accept('cedar', subagent('stop', 'agent-1', { tmux: 'cc-meadow-hr:0.0' }), false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates.flat().at(-1)).toMatchObject({ sessionId: A, helpers: 0, tool: null });
  });

  it.each([['ended'], ['removed']])('a session that is %s loses its record and the map hears it once', async (how) => {
    const t = setup();
    t.start(A, 'Bash', 'npm test', 'a-1');
    service.accept('cedar', meters({ context_pct: 50 }, { tmux: 'cc-meadow-hr:0.0' }), false);
    await vi.advanceTimersByTimeAsync(2_000);
    const before = t.updates.length;
    if (how === 'ended') t.bus.emit('session.updated', session(A, 'ended'));
    else t.bus.emit('session.removed', { id: A });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates.slice(before)).toEqual([[{
      sessionId: A, tool: null, paused: false, helpers: 0, contextPct: null, lastStepAt: null, title: null, helperTypes: [], turnStartedAt: null,
    }]]);
    expect(service.detail(A)).toEqual({
      sessionId: A, current: null, steps: [], todos: [], helpers: [], meters: null, paused: false, pauseHit: false,
    });
    expect(service.snapshot()).toEqual([]);
    t.bus.emit('session.removed', { id: A });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates.slice(before)).toHaveLength(1);
  });

  it('ending a session without any activity tells the map nothing (kit 1)', async () => {
    const t = setup();
    t.bus.emit('session.updated', session(A, 'ended'));
    t.bus.emit('session.removed', { id: B });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates).toEqual([]);
  });
});

describe('pause', () => {
  it('a pause change sends a view with paused: true even for a session without a step', () => {
    const t = setup();
    t.pauses.set(C, true);
    const bare = { sessionId: C, tool: null, paused: true, helpers: 0, contextPct: null, lastStepAt: null, title: null, helperTypes: [], turnStartedAt: null };
    expect(t.updates).toEqual([[bare]]);
    expect(service.snapshot()).toEqual([bare]);
    expect(service.detail(C)).toMatchObject({ paused: true, pauseHit: false });
  });

  it('keeps pauseHit while paused when the stopped turn ends, and clears it on resume', async () => {
    const t = setup();
    t.start(A, 'Bash', 'npm test', 'a-1');
    t.pauses.set(A, true);
    service.accept('cedar', pausedEvent({ tmux: 'cc-meadow-hr:0.0' }), false);
    t.bus.emit('session.updated', session(A, 'idle'));
    expect(service.detail(A)).toMatchObject({ paused: true, pauseHit: true, current: null });
    t.pauses.set(A, false);
    expect(service.detail(A)).toMatchObject({ paused: false, pauseHit: false });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates.flat().at(-1)).toMatchObject({ sessionId: A, paused: false });
  });

  it('a pause that hit with no Stop after it: the session stays working, the map shows paused and no tool', async () => {
    const t = setup();
    t.start(A, 'Bash', 'npm test', 'a-1');
    t.bus.emit('session.updated', session(A, 'working'));
    t.pauses.set(A, true);
    t.end(A, 'Bash', 'npm test', 'a-1');
    service.accept('cedar', pausedEvent({ tmux: 'cc-meadow-hr:0.0' }), false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(service.snapshot()).toEqual([expect.objectContaining({ sessionId: A, paused: true, tool: null })]);
    expect(service.detail(A)).toMatchObject({ paused: true, pauseHit: true, current: null });
    expect(t.updates.flat().at(-1)).toMatchObject({ sessionId: A, paused: true, tool: null });
    expect(t.pauses.markHit).toHaveBeenCalledWith(A);
  });

  it('a step that started after the hit clears the mark in the pause service and in the detail; an older one does not', () => {
    const t = setup();
    t.pauses.set(A, true);
    service.accept('cedar', pausedEvent({ tmux: 'cc-meadow-hr:0.0', ts: '2026-10-09T12:01:00Z' }), false);
    t.start(A, 'Bash', 'late async start', 'old-1', { ts: '2026-10-09T12:00:50Z' });
    expect(t.pauses.clearHit).not.toHaveBeenCalled();
    expect(service.detail(A)).toMatchObject({ paused: true, pauseHit: true });
    t.start(A, 'Read', 'a.ts', 'new-1', { ts: '2026-10-09T12:01:30Z' });
    expect(t.pauses.clearHit).toHaveBeenCalledWith(A);
    expect(service.detail(A)).toMatchObject({ paused: true, pauseHit: false });
  });

  it('snapshot leaves system sessions out', () => {
    const t = setup();
    t.pauses.set(BRAIN, true);
    expect(service.snapshot()).toEqual([]);
    expect(t.updates).toEqual([]);
  });
});

describe('sessions that are gone', () => {
  it('a step for a session the registry does not know or holds as ended is ignored', async () => {
    const t = setup();
    t.gone.add(A);
    t.start(A, 'Bash', 'npm test', 'a-1');
    service.accept('cedar', pausedEvent({ tmux: 'cc-meadow-hr:0.0' }), false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates).toEqual([]);
    expect(service.snapshot()).toEqual([]);
    expect(t.pauses.markHit).not.toHaveBeenCalled();
  });

  it('a step that arrives after its session ended does not bring the record back', async () => {
    const t = setup();
    t.start(A, 'Bash', 'npm test', 'a-1');
    t.bus.emit('session.updated', session(A, 'ended'));
    t.gone.add(A);
    t.start(A, 'Read', 'late', 'a-2');
    t.end(A, 'Bash', 'npm test', 'a-1');
    expect(service.snapshot()).toEqual([]);
    expect(service.detail(A).steps).toEqual([]);
  });

  it('the registry is asked once per new record, not once per step', () => {
    const t = setup();
    for (let i = 0; i < 10; i += 1) t.start(A, 'Read', `f${i}`, `a-${i}`);
    expect(t.isLive.mock.calls.filter(([id]) => id === A)).toHaveLength(1);
  });

  it('sweep() drops the records of sessions that are gone and tells the map once', async () => {
    const t = setup();
    t.start(A, 'Bash', 'npm test', 'a-1');
    t.start(B, 'Bash', 'npm test', 'b-1');
    await vi.advanceTimersByTimeAsync(2_000);
    const before = t.updates.length;
    t.gone.add(B);
    service.sweep();
    expect(service.snapshot().map((view) => view.sessionId)).toEqual([A]);
    expect(t.updates.slice(before)).toEqual([[expect.objectContaining({ sessionId: B, tool: null })]]);
    service.sweep();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates.slice(before)).toHaveLength(1);
  });
});

describe('stop', () => {
  it('after stop() advancing timers emits nothing and records are gone', async () => {
    const t = setup();
    service.watch(A);
    t.start(A, 'Bash', 'npm test', 'a-1');
    t.start(B, 'Bash', 'npm test', 'b-1');
    service.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.updates).toHaveLength(1);
    expect(t.streams).toEqual([]);
    expect(service.snapshot()).toEqual([]);
    t.start(A, 'Bash', 'again', 'a-2');
    t.bus.emit('session.updated', session(A, 'idle'));
    t.pauses.set(A, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.updates).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('turn start on the map', () => {
  it('a running turn shows when it started, and the view clears it when the turn ends', async () => {
    const t = setup();
    t.start(A, 'Bash', 'npm test', 'a-1');
    await vi.advanceTimersByTimeAsync(2_000);
    const started = '2026-10-09T12:00:00.000Z';
    t.bus.emit('session.updated', { ...session(A, 'working'), turnStartedAt: started });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates.flat().at(-1)).toMatchObject({ sessionId: A, turnStartedAt: started, title: 'npm test' });
    expect(service.snapshot()[0]?.turnStartedAt).toBe(started);
    t.bus.emit('session.updated', session(A, 'idle'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.updates.flat().at(-1)).toMatchObject({ sessionId: A, turnStartedAt: null, tool: null });
  });
});
