import { z } from 'zod';
import { ACTION_ACTORS, ActionStatusSchema, ChannelSchema, type ActionActor, type ActionDTO, type ActionStatus, type Channel } from '@luady/shared';
import type { ActionKind, Db } from '../core/contracts.js';
import { ACTION_KINDS } from './params.js';
import { resumeOf } from './resume.js';

export interface ActionRecord {
  readonly id: string;
  readonly seq: number;
  readonly actor: ActionActor;
  readonly channel: Channel;
  readonly kind: ActionKind;
  readonly tier: 0 | 1;
  readonly summary: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly status: ActionStatus;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly executedAt: string | null;
  readonly resultText: string | null;
  readonly error: string | null;
}

export type NewAction = Pick<
  ActionRecord,
  'actor' | 'channel' | 'kind' | 'tier' | 'summary' | 'params' | 'status' | 'createdAt' | 'decidedAt'
>;

export interface ActionChange {
  readonly status: ActionStatus;
  readonly decidedAt?: string;
  readonly executedAt?: string;
  readonly resultText?: string;
  readonly error?: string;
}

export interface ActionStore {
  insert(action: NewAction): ActionRecord;
  get(id: string): ActionRecord | undefined;
  /** Compare-and-set: applies `change` only while the row still has status `from`; null otherwise. */
  transition(id: string, from: ActionStatus, change: ActionChange): ActionRecord | null;
  list(filter: { status?: ActionStatus; limit: number }): ActionRecord[];
  pendingCreatedUpTo(cutoffIso: string): ActionRecord[];
}

export const ACTION_LIST_MAX = 1000;

const ActionRowSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  actor: z.enum(ACTION_ACTORS),
  channel: ChannelSchema,
  kind: z.enum(ACTION_KINDS),
  tier: z.union([z.literal(0), z.literal(1)]),
  summary: z.string(),
  params_json: z.string(),
  status: ActionStatusSchema,
  created_at: z.string(),
  decided_at: z.string().nullable(),
  executed_at: z.string().nullable(),
  result_text: z.string().nullable(),
  error: z.string().nullable(),
});

function parseParams(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toRecord(row: unknown): ActionRecord {
  const r = ActionRowSchema.parse(row);
  return {
    id: r.id,
    seq: r.seq,
    actor: r.actor,
    channel: r.channel,
    kind: r.kind,
    tier: r.tier,
    summary: r.summary,
    params: parseParams(r.params_json),
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    executedAt: r.executed_at,
    resultText: r.result_text,
    error: r.error,
  };
}

export function toActionDTO(record: ActionRecord): ActionDTO {
  const resume = record.kind === 'session.resume' && record.status === 'done' ? resumeOf(record.resultText) : undefined;
  return {
    ...(resume === undefined ? {} : { resume }),
    id: record.id,
    actor: record.actor,
    channel: record.channel,
    kind: record.kind,
    tier: record.tier,
    summary: record.summary,
    status: record.status,
    createdAt: record.createdAt,
    decidedAt: record.decidedAt,
    result: record.resultText,
    error: record.error,
  };
}

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), ACTION_LIST_MAX);
}

function applyChange(current: ActionRecord, change: ActionChange): ActionRecord {
  return {
    ...current,
    status: change.status,
    decidedAt: change.decidedAt ?? current.decidedAt,
    executedAt: change.executedAt ?? current.executedAt,
    resultText: change.resultText ?? current.resultText,
    error: change.error ?? current.error,
  };
}

export function createActionStore(db: Db): ActionStore {
  const maxSeq = db.prepare<[], { max_seq: number | null }>('SELECT MAX(seq) AS max_seq FROM actions');
  const insertRow = db.prepare<[string, number, string, string, string, number, string, string, string, string, string | null]>(
    `INSERT INTO actions (id, seq, actor, channel, kind, tier, summary, params_json, status, created_at, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectOne = db.prepare<[string]>('SELECT * FROM actions WHERE id = ?');
  const updateRow = db.prepare<[string, string | null, string | null, string | null, string | null, string, string]>(
    'UPDATE actions SET status = ?, decided_at = ?, executed_at = ?, result_text = ?, error = ? WHERE id = ? AND status = ?',
  );
  const listAll = db.prepare<[number]>('SELECT * FROM actions ORDER BY seq DESC LIMIT ?');
  const listByStatus = db.prepare<[string, number]>('SELECT * FROM actions WHERE status = ? ORDER BY seq DESC LIMIT ?');
  const pendingUpTo = db.prepare<[string]>(
    "SELECT * FROM actions WHERE status = 'pending_confirmation' AND created_at <= ? ORDER BY seq",
  );

  const get = (id: string): ActionRecord | undefined => {
    const row = selectOne.get(id);
    return row === undefined ? undefined : toRecord(row);
  };
  const insert = db.transaction((action: NewAction): ActionRecord => {
    const seq = (maxSeq.get()?.max_seq ?? 0) + 1;
    const record: ActionRecord = { ...action, id: `A${seq}`, seq, params: { ...action.params }, executedAt: null, resultText: null, error: null };
    insertRow.run(record.id, seq, record.actor, record.channel, record.kind, record.tier, record.summary, JSON.stringify(record.params), record.status, record.createdAt, record.decidedAt);
    return record;
  });
  const transition = db.transaction((id: string, from: ActionStatus, change: ActionChange): ActionRecord | null => {
    const current = get(id);
    if (current === undefined || current.status !== from) return null;
    const next = applyChange(current, change);
    const result = updateRow.run(next.status, next.decidedAt, next.executedAt, next.resultText, next.error, id, from);
    return result.changes === 1 ? next : null;
  });

  return {
    insert: (action) => insert(action),
    get,
    transition: (id, from, change) => transition(id, from, change),
    list: (filter) => {
      const limit = clampLimit(filter.limit);
      const rows = filter.status === undefined ? listAll.all(limit) : listByStatus.all(filter.status, limit);
      return rows.map(toRecord);
    },
    pendingCreatedUpTo: (cutoffIso) => pendingUpTo.all(cutoffIso).map(toRecord),
  };
}
