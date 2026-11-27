import { LIMITS, type NoticeDTO, type StepDTO } from '@luady/shared';
import { describe, expect, it } from 'vitest';
import {
  applySteps, emptyDetail, loadActivity, loadNotices, mergeActivity, mergeDetail, upsertNotice,
} from '../../src/state/activity.js';
import { activityItem, detail, notice, step } from '../fixtures.js';

const SID = 'cedar:cc-meadow-hr:0.0';
const at = (minute: number): string => new Date(Date.UTC(2026, 9, 9, 12, minute)).toISOString();
const open = (id: string, over: Partial<StepDTO> = {}): StepDTO =>
  step({ id, startedAt: at(1), endedAt: null, ok: null, added: null, removed: null, ...over });
const appended = (steps: readonly StepDTO[], over: { todos?: never[] | null; helpers?: never[] | null } = {}) =>
  ({ type: 'steps.appended' as const, sessionId: SID, steps: [...steps], todos: over.todos ?? null, helpers: over.helpers ?? null });

describe('mergeActivity', () => {
  it('replaces one entry and keeps the others by reference', () => {
    const other = activityItem({ sessionId: 'birch:a:0.0' });
    const prev = { [SID]: activityItem(), 'birch:a:0.0': other };
    const next = mergeActivity(prev, [activityItem({ tool: 'run' })]);
    expect(next[SID]?.tool).toBe('run');
    expect(next['birch:a:0.0']).toBe(other);
    expect(prev[SID]?.tool).toBe('edit');
  });

  it('returns the same record when nothing changed', () => {
    const prev = { [SID]: activityItem() };
    expect(mergeActivity(prev, [activityItem()])).toBe(prev);
    expect(mergeActivity(prev, [])).toBe(prev);
  });

  it('a full load drops sessions that are gone and keeps equal entries', () => {
    const kept = activityItem();
    const next = loadActivity({ [SID]: kept, 'birch:old:0.0': activityItem({ sessionId: 'birch:old:0.0' }) }, [activityItem()]);
    expect(Object.keys(next)).toEqual([SID]);
    expect(next[SID]).toBe(kept);
  });
});

describe('applySteps', () => {
  it('upserts by id: a start then an end of the same id leave one step', () => {
    const base = detail({ steps: [] });
    const started = applySteps(base, appended([open('t1')]));
    expect(started.current?.id).toBe('t1');
    const ended = applySteps(started, appended([step({ id: 't1', startedAt: at(1), endedAt: at(2) })]));
    expect(ended.steps.map((s) => s.id)).toEqual(['t1']);
    expect(ended.steps[0]?.endedAt).toBe(at(2));
    expect(ended.current).toBeNull();
  });

  it('keeps the newest forty steps', () => {
    const many = Array.from({ length: 45 }, (_, i) => step({ id: `s${i}` }));
    const next = applySteps(detail({ steps: [] }), appended(many));
    expect(next.steps).toHaveLength(LIMITS.stepRingSize);
    expect(next.steps[0]?.id).toBe('s5');
    expect(next.steps.at(-1)?.id).toBe('s44');
  });

  it('replaces to-dos and helpers only when they are given', () => {
    const base = detail({ todos: [{ id: '1', subject: 'Write the test', status: 'pending' }], helpers: [] });
    expect(applySteps(base, appended([step({ id: 'x' })])).todos).toBe(base.todos);
    const todos = [{ id: '1', subject: 'Write the test', status: 'completed' as const }];
    const helpers = [{ agentId: 'h1', agentType: 'Explore', startedAt: at(1) }];
    const next = applySteps(base, { ...appended([]), todos, helpers });
    expect(next.todos).toEqual(todos);
    expect(next.helpers).toEqual(helpers);
  });

  it('current is the newest open main-thread step, else the newest open step', () => {
    const helperStep = open('h', { agentId: 'a1' });
    const both = applySteps(detail({ steps: [] }), appended([open('main'), helperStep]));
    expect(both.current?.id).toBe('main');
    const onlyHelper = applySteps(both, appended([step({ id: 'main', endedAt: at(3) })]));
    expect(onlyHelper.current?.id).toBe('h');
  });

  it('never changes the detail it was given', () => {
    const base = detail();
    const before = JSON.stringify(base);
    applySteps(base, appended([open('t9')]));
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('mergeDetail', () => {
  it('a loaded detail keeps steps that arrived on the socket before it, once', () => {
    const early = applySteps(emptyDetail(SID), appended([open('live')]));
    const loaded = detail({ steps: [step({ id: 'old' }), open('live')] });
    expect(mergeDetail(early, loaded).steps.map((s) => s.id)).toEqual(['old', 'live']);
    const later = applySteps(emptyDetail(SID), appended([open('newer')]));
    expect(mergeDetail(later, loaded).steps.map((s) => s.id)).toEqual(['old', 'live', 'newer']);
    expect(mergeDetail(undefined, loaded)).toBe(loaded);
  });
});

describe('notices', () => {
  const n = (id: string, over: Partial<NoticeDTO> = {}): NoticeDTO => notice({ id, ...over });

  it('upsertNotice replaces by id in place or puts a new one first', () => {
    const list = [n('b'), n('a')];
    expect(upsertNotice(list, n('c')).map((x) => x.id)).toEqual(['c', 'b', 'a']);
    const replaced = upsertNotice(list, n('a', { settledAt: at(5) }));
    expect(replaced.map((x) => x.id)).toEqual(['b', 'a']);
    expect(replaced[1]?.settledAt).toBe(at(5));
  });

  it('cuts to one hundred, dropping the oldest settled ones first', () => {
    const list = Array.from({ length: 100 }, (_, i) => n(`n${99 - i}`, { settledAt: i === 50 ? at(1) : null }));
    const next = upsertNotice(list, n('new'));
    expect(next).toHaveLength(100);
    expect(next[0]?.id).toBe('new');
    expect(next.some((x) => x.id === 'n49')).toBe(false);
    expect(next.at(-1)?.id).toBe('n0');
    const unsettled = Array.from({ length: 100 }, (_, i) => n(`u${99 - i}`));
    expect(upsertNotice(unsettled, n('new')).at(-1)?.id).toBe('u1');
  });

  it('loadNotices sorts newest first and caps', () => {
    const loaded = loadNotices([n('old', { createdAt: at(1) }), n('new', { createdAt: at(9) })]);
    expect(loaded.map((x) => x.id)).toEqual(['new', 'old']);
  });
});
