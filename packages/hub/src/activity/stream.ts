import type { StepDTO } from '@luady/shared';
import type { HubEvents } from '../core/contracts.js';
import type { SessionActivity } from './store.js';

export interface StepStreamDeps {
  flushMs: number;
  current: (sessionId: string) => SessionActivity | undefined;
  emit: (payload: HubEvents['steps.appended']) => void;
}

export interface StepStream {
  watch(sessionId: string): void;
  unwatch(sessionId: string): void;
  /** Collects what changed between two records of a watched session; unwatched sessions cost nothing. */
  collect(sessionId: string, prev: SessionActivity, next: SessionActivity): void;
  /** Drops anything collected for the session (it ended or was removed). */
  drop(sessionId: string): void;
  stop(): void;
}

interface Pending {
  readonly steps: ReadonlyMap<string, StepDTO>;
  readonly todos: boolean;
  readonly helpers: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Per watched session: changed steps collect for `flushMs` and go out once, each step in its latest form. */
export function createStepStream(deps: StepStreamDeps): StepStream {
  const watchers = new Map<string, number>();
  const pending = new Map<string, Pending>();

  function flush(sessionId: string): void {
    const batch = pending.get(sessionId);
    pending.delete(sessionId);
    if (batch === undefined) return;
    const record = deps.current(sessionId);
    deps.emit({
      sessionId,
      steps: [...batch.steps.values()],
      todos: batch.todos && record !== undefined ? [...record.todos] : null,
      helpers: batch.helpers && record !== undefined ? [...record.helpers] : null,
    });
  }

  function drop(sessionId: string): void {
    const batch = pending.get(sessionId);
    if (batch !== undefined) clearTimeout(batch.timer);
    pending.delete(sessionId);
  }

  function collect(sessionId: string, prev: SessionActivity, next: SessionActivity): void {
    if (!watchers.has(sessionId)) return;
    const changed = next.steps.filter((step) => !prev.steps.includes(step));
    const todos = next.todos !== prev.todos;
    const helpers = next.helpers !== prev.helpers;
    if (changed.length === 0 && !todos && !helpers) return;
    const before = pending.get(sessionId);
    pending.set(sessionId, {
      steps: new Map([...(before?.steps ?? []), ...changed.map((step) => [step.id, step] as const)]),
      todos: (before?.todos ?? false) || todos,
      helpers: (before?.helpers ?? false) || helpers,
      timer: before?.timer ?? setTimeout(() => flush(sessionId), deps.flushMs),
    });
  }

  return {
    watch(sessionId) {
      watchers.set(sessionId, (watchers.get(sessionId) ?? 0) + 1);
    },
    unwatch(sessionId) {
      const left = (watchers.get(sessionId) ?? 0) - 1;
      if (left > 0) {
        watchers.set(sessionId, left);
        return;
      }
      watchers.delete(sessionId);
      drop(sessionId);
    },
    collect,
    drop,
    stop() {
      for (const batch of pending.values()) clearTimeout(batch.timer);
      pending.clear();
      watchers.clear();
    },
  };
}
