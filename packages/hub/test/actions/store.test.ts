import { describe, expect, it } from 'vitest';
import { ActionDTOSchema } from '@luady/shared';
import { openMemoryDb } from '../../src/db/open.js';
import { createActionStore, toActionDTO, type ActionRecord, type NewAction } from '../../src/actions/store.js';

const T0 = '2026-10-09T12:00:00.000Z';

function newAction(over: Partial<NewAction> = {}): NewAction {
  return {
    actor: 'manager',
    channel: 'event',
    kind: 'session.stop',
    tier: 1,
    summary: 'stop session cedar · meadow-hr',
    params: { sessionId: 'cedar:cc-meadow-hr:0.0', force: false },
    status: 'pending_confirmation',
    createdAt: T0,
    decidedAt: null,
    ...over,
  };
}

function must(record: ActionRecord | null | undefined): ActionRecord {
  if (record === null || record === undefined) throw new Error('expected a record');
  return record;
}

describe('createActionStore', () => {
  it('numbers actions A1, A2, … and continues after reopening', () => {
    const db = openMemoryDb();
    const store = createActionStore(db);
    expect(store.insert(newAction()).id).toBe('A1');
    expect(store.insert(newAction()).id).toBe('A2');
    expect(createActionStore(db).insert(newAction()).id).toBe('A3');
  });

  it('round-trips every field', () => {
    const store = createActionStore(openMemoryDb());
    const inserted = store.insert(newAction());
    expect(inserted).toEqual({ ...newAction(), id: 'A1', seq: 1, executedAt: null, resultText: null, error: null });
    expect(store.get('A1')).toEqual(inserted);
    expect(store.get('A2')).toBeUndefined();
  });

  it('copies params instead of keeping the caller object', () => {
    const store = createActionStore(openMemoryDb());
    const params = { sessionId: 'cedar:cc-meadow-hr:0.0', force: false };
    const inserted = store.insert(newAction({ params }));
    expect(inserted.params).toEqual(params);
    expect(inserted.params).not.toBe(params);
  });

  it('transitions only from the expected status', () => {
    const store = createActionStore(openMemoryDb());
    const pending = store.insert(newAction());
    const approved = store.transition('A1', 'pending_confirmation', { status: 'approved', decidedAt: '2026-10-09T12:01:00.000Z' });
    expect(approved).toMatchObject({ status: 'approved', decidedAt: '2026-10-09T12:01:00.000Z' });
    expect(pending.status).toBe('pending_confirmation');
    expect(store.transition('A1', 'pending_confirmation', { status: 'denied' })).toBeNull();
    const done = store.transition('A1', 'approved', { status: 'done', executedAt: '2026-10-09T12:01:05.000Z', resultText: 'stopped' });
    expect(done).toMatchObject({
      status: 'done',
      decidedAt: '2026-10-09T12:01:00.000Z',
      executedAt: '2026-10-09T12:01:05.000Z',
      resultText: 'stopped',
      error: null,
    });
    expect(store.get('A1')).toEqual(done);
    expect(store.transition('A9', 'pending_confirmation', { status: 'denied' })).toBeNull();
  });

  it('lists newest first, filters by status and clamps the limit', () => {
    const store = createActionStore(openMemoryDb());
    store.insert(newAction());
    store.insert(newAction({ status: 'approved', tier: 0, kind: 'session.send', decidedAt: T0 }));
    store.insert(newAction());
    expect(store.list({ limit: 10 }).map((record) => record.id)).toEqual(['A3', 'A2', 'A1']);
    expect(store.list({ status: 'pending_confirmation', limit: 10 }).map((record) => record.id)).toEqual(['A3', 'A1']);
    expect(store.list({ limit: 1 }).map((record) => record.id)).toEqual(['A3']);
    expect(store.list({ limit: 0 }).map((record) => record.id)).toEqual(['A3']);
  });

  it('finds pending actions created up to a cutoff', () => {
    const store = createActionStore(openMemoryDb());
    store.insert(newAction({ createdAt: '2026-10-09T11:00:00.000Z' }));
    store.insert(newAction({ createdAt: '2026-10-09T11:30:00.000Z' }));
    store.insert(newAction({ createdAt: '2026-10-09T11:45:00.000Z' }));
    store.insert(newAction({ createdAt: '2026-10-09T11:00:00.000Z', status: 'denied', decidedAt: T0 }));
    expect(store.pendingCreatedUpTo('2026-10-09T11:30:00.000Z').map((record) => record.id)).toEqual(['A1', 'A2']);
  });

  it('maps records to valid ActionDTOs', () => {
    const store = createActionStore(openMemoryDb());
    store.insert(newAction());
    const failed = must(store.transition('A1', 'pending_confirmation', { status: 'failed', decidedAt: T0, executedAt: T0, error: 'boom' }));
    const dto = toActionDTO(failed);
    expect(ActionDTOSchema.parse(dto)).toEqual(dto);
    expect(dto).toEqual({
      id: 'A1',
      actor: 'manager',
      channel: 'event',
      kind: 'session.stop',
      tier: 1,
      summary: 'stop session cedar · meadow-hr',
      status: 'failed',
      createdAt: T0,
      decidedAt: T0,
      result: null,
      error: 'boom',
    });
  });
});

describe('the DTO of a finished resume says what happened', () => {
  it.for([
    ['resumed', { wasHit: true, sent: true }],
    ['pause lifted; the agent was still working', { wasHit: false, sent: false }],
    ['pause lifted; the agent was idle', { wasHit: true, sent: false }],
  ] as const)('%s', ([text, resume]) => {
    const store = createActionStore(openMemoryDb());
    store.insert(newAction({ kind: 'session.resume', tier: 0, status: 'approved', decidedAt: T0, params: { sessionId: 'cedar:cc-meadow-hr:0.0' } }));
    const done = must(store.transition('A1', 'approved', { status: 'done', executedAt: T0, resultText: text }));
    const dto = toActionDTO(done);
    expect(dto.resume).toEqual(resume);
    expect(ActionDTOSchema.parse(dto)).toEqual(dto);
  });

  it('no other action carries it', () => {
    const store = createActionStore(openMemoryDb());
    store.insert(newAction());
    expect(toActionDTO(must(store.get('A1')))).not.toHaveProperty('resume');
  });
});
